#!/usr/bin/env python3
"""Actions runner ingest: process pending tracks -> yt-dlp mp3 -> POST /api/upload.

Runs inside the GitHub Actions workflow (S1). Env required:
  SITE, ADMIN_EMAIL, ADMIN_PASSWORD
Reads /tmp/pending.json (fetched by the workflow), uploads finished MP3s, marks queue rows.
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

SITE = os.environ.get('SITE', 'https://hedge-music-alpha.pages.dev')
UA = 'hedge-music-ingest/1.0'  # Cloudflare 403s the default Python-urllib UA


def login():
    body = json.dumps({'action': 'login', 'email': os.environ['ADMIN_EMAIL'],
                       'password': os.environ['ADMIN_PASSWORD']}).encode()
    req = urllib.request.Request(SITE + '/api/auth', data=body,
                                 headers={'content-type': 'application/json', 'user-agent': UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        tok = r.headers['set-cookie'].split('hm_token=')[1].split(';')[0]
    return 'hm_token=' + tok


TOKEN = login()


def api(path, payload=None, ctype='application/json', raw=None):
    headers = {'cookie': TOKEN, 'user-agent': UA}
    data_out = None
    if raw is not None:
        data_out = raw
        headers['content-type'] = ctype
    elif payload is not None:
        data_out = json.dumps(payload).encode()
        headers['content-type'] = 'application/json'
    req = urllib.request.Request(SITE + path, data=data_out, headers=headers,
                                 method='POST' if data_out is not None else 'GET')
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.load(r)


def run(cmd, timeout=600):
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:3])} failed: {p.stderr[:300]}")
    return p.stdout


def main():
    data = json.load(open('/tmp/pending.json'))
    jobs = []
    for q in data.get('queue', []):
        jobs.append({'original_url': q['original_url'], 'queue_id': q['id']})
    for t in data.get('upgrade', []):
        jobs.append({'original_url': t['original_url'], 'queue_id': None})
    jobs = jobs[:10]
    if not jobs:
        print('nothing pending')
        return
    print(f"{len(jobs)} job(s)")

    for job in jobs:
        url = job['original_url']
        qid = job['queue_id']
        print('--- processing:', url)
        f = '/tmp/ing.mp3'
        try:
            meta_out = run(['yt-dlp', '--print-json', '--no-download', '--no-playlist',
                            '--no-warnings', url], timeout=120)
            info = json.loads(meta_out.strip().splitlines()[0])

            run(['yt-dlp', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
                 '--no-playlist', '--no-warnings', '-o', '/tmp/ing.%(ext)s', url])
            if not os.path.exists(f):
                raise RuntimeError('mp3 not produced')
            size = os.path.getsize(f)
            if size > 95 * 1024 * 1024:
                raise RuntimeError(f'too big: {size}')

            dur_out = run(['ffprobe', '-v', 'quiet', '-show_entries', 'format=duration',
                           '-of', 'csv=p=0', f], timeout=30)
            duration = int(float(dur_out.strip() or 0)) or None

            q = urllib.parse.urlencode({
                'original_url': url,
                'title': (info.get('title') or 'Unknown')[:200],
                'artist': (info.get('artist') or info.get('uploader') or info.get('channel') or '')[:120],
                'thumbnail': (info.get('thumbnail') or (info.get('thumbnails') or [{}])[-1].get('url', '') or '')[:500],
                'duration': duration or info.get('duration') or '',
                'extractor': (info.get('extractor') or 'youtube')[:30],
                'extractor_id': str(info.get('id') or '')[:80],
            })
            with open(f, 'rb') as fh:
                resp = api('/api/upload?' + q, raw=fh.read(), ctype='audio/mpeg')
            print('  uploaded:', resp)
            os.remove(f)
            if qid:
                api('/api/ingest-pending', {'queue_id': qid, 'status': 'done'})
        except Exception as e:
            print('  FAILED:', str(e)[:300])
            if qid:
                try:
                    api('/api/ingest-pending', {'queue_id': qid, 'status': 'error', 'error': str(e)[:300]})
                except Exception:
                    pass
    print('batch complete')


if __name__ == '__main__':
    sys.exit(main())
