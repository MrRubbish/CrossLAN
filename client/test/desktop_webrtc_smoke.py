import hashlib
import json
import os
from pathlib import Path
import tempfile
import zipfile
from playwright.sync_api import sync_playwright, expect


URL = os.environ.get('CROSSLAN_TEST_URL', 'http://localhost:6202')
OUT = Path(__file__).resolve().parents[2] / '.test-results'
MIB = 1024 * 1024
errors = []
payload_requests = []
results = []
OUT.mkdir(exist_ok=True)


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as source:
        for block in iter(lambda: source.read(MIB), b''):
            result.update(block)
    return result.hexdigest()


def create_file(folder, name, size):
    target = folder / name
    block = bytes(range(256)) * (MIB // 256)
    with target.open('wb') as output:
        for _ in range(size // MIB):
            output.write(block)
        output.write(block[:size % MIB])
    return target


def task(page, name):
    return page.locator('.transfer-task').filter(has_text=name).last


def completed(page, name):
    row = task(page, name)
    expect(row).to_have_attribute('data-done', 'true', timeout=120000)
    expect(row).to_have_attribute('data-cancelled', 'false')
    expect(row).to_have_attribute('data-mode', 'p2p')
    expect(row).to_contain_text('100%')
    expect(row.get_by_role('button', name='取消', exact=True)).to_have_count(0)


def send_and_verify(sender, receiver, source, destination):
    with receiver.expect_download(timeout=120000) as download_event:
        sender.locator('input[type=file]').set_input_files(str(source))
    download_event.value.save_as(str(destination))
    completed(sender, source.name)
    completed(receiver, source.name)
    assert digest(source) == digest(destination)
    results.append({'case': source.name, 'bytes': source.stat().st_size, 'sha256': digest(source)})
    print(json.dumps(results[-1]), flush=True)


with tempfile.TemporaryDirectory(prefix='crosslan-desktop-rtc-') as tmp, sync_playwright() as p:
    folder = Path(tmp)
    browsers = []
    try:
        for _ in range(2):
            browsers.append(p.chromium.launch(headless=True, channel='msedge', args=['--no-proxy-server']))
        desktop = browsers[0].new_context(locale='zh-CN', accept_downloads=True, viewport={'width': 1360, 'height': 880})
        mobile = browsers[1].new_context(locale='zh-CN', accept_downloads=True, viewport={'width': 390, 'height': 844},
                                          user_agent='Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36')
        sender = desktop.new_page()
        receiver = mobile.new_page()
        prompts = []
        for page in [sender, receiver]:
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('request', lambda request: payload_requests.append(request.url) if '/api/transfers' in request.url else None)
            page.on('dialog', lambda dialog: (prompts.append(dialog.message), dialog.accept()))
            page.goto(URL)
            page.wait_for_load_state('networkidle')
        expect(sender.locator('input[type=file]')).to_have_count(1)
        expect(receiver.locator('input[type=file]')).to_have_count(1)
        sender.screenshot(path=str(OUT / 'desktop-rtc-before.png'), full_page=True)

        source48 = create_file(folder, 'desktop-48mib.bin', 48 * MIB)
        source64 = create_file(folder, 'desktop-64mib.bin', 64 * MIB)
        send_and_verify(sender, receiver, source48, folder / 'received-48.bin')
        send_and_verify(receiver, sender, source64, folder / 'received-64.bin')

        # A throttled receive is cancelled before any Blob download can be published.
        retry = create_file(folder, 'cancel-retry.bin', 8 * MIB)
        downloads = []
        receiver.on('download', lambda download: downloads.append(download.suggested_filename))
        sender.get_by_role('radio', name='手动', exact=True).check()
        sender.locator('input[type=number]').fill('4')
        sender.locator('input[type=file]').set_input_files(str(retry))
        active = task(receiver, retry.name)
        expect(active).not_to_have_attribute('data-bytes', '0', timeout=30000)
        active.get_by_role('button', name='取消', exact=True).click()
        expect(task(sender, retry.name)).to_have_attribute('data-cancelled', 'true', timeout=10000)
        expect(active).to_have_attribute('data-cancelled', 'true')
        expect(active.get_by_role('link')).to_have_count(0)
        receiver.wait_for_timeout(300)
        assert not downloads
        sender.get_by_role('radio', name='不限速', exact=True).check()
        send_and_verify(sender, receiver, retry, folder / 'retried.bin')
        results.append({'case': 'receiver cancellation and same-file retry', 'passed': True})

        sender.get_by_role('radio', name='手动', exact=True).check()
        sender.locator('input[type=number]').fill('4')
        downloads.clear()
        sender.locator('input[type=file]').set_input_files(str(retry))
        active = task(receiver, retry.name)
        expect(active).not_to_have_attribute('data-bytes', '0', timeout=30000)
        task(sender, retry.name).get_by_role('button', name='取消', exact=True).click()
        expect(active).to_have_attribute('data-cancelled', 'true', timeout=10000)
        expect(task(sender, retry.name)).to_have_attribute('data-cancelled', 'true')
        receiver.wait_for_timeout(300)
        assert not downloads
        sender.get_by_role('radio', name='不限速', exact=True).check()
        results.append({'case': 'sender cancellation / no stale download', 'passed': True})

        # Actual ZIP packaging and P2P preflight reuse the one batch approval.
        small1 = create_file(folder, 'batch-one.bin', MIB)
        small2 = create_file(folder, 'batch-two.bin', 2 * MIB)
        before = len(prompts)
        with receiver.expect_download(timeout=45000) as batch_event:
            sender.locator('input[type=file]').set_input_files([str(small1), str(small2)])
        zipped = folder / 'batch.zip'
        batch_event.value.save_as(str(zipped))
        with zipfile.ZipFile(zipped) as archive:
            # Production prefixes each name so duplicate names stay distinct.
            entries = {f'{index:03d}-{source.name}': source for index, source in enumerate([small1, small2], 1)}
            assert set(archive.namelist()) == set(entries), archive.namelist()
            for name, source in entries.items():
                assert hashlib.sha256(archive.read(name)).hexdigest() == digest(source)
        assert len(prompts) - before == 1, prompts[before:]
        completed(sender, batch_event.value.suggested_filename)
        completed(receiver, batch_event.value.suggested_filename)
        results.append({'case': 'ZIP batch / one confirmation / intact contents', 'passed': True})

        receiver.get_by_role('button', name='清空任务', exact=True).click()
        expect(receiver.locator('.transfer-task')).to_have_count(0)
        receiver.screenshot(path=str(OUT / 'desktop-rtc-mobile.png'), full_page=True)
        sender.screenshot(path=str(OUT / 'desktop-rtc-complete.png'), full_page=True)
        for page in [sender, receiver]:
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert not payload_requests, payload_requests
        assert not errors, errors
        print(json.dumps({'results': results, 'file_api_requests': payload_requests, 'page_errors': errors}), flush=True)
        (OUT / 'desktop-rtc-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
    finally:
        for browser in browsers:
            browser.close()
