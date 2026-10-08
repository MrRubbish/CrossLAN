"""Exercise the QR dialog against a running CrossLAN server with an advertised LAN IP."""

import argparse
from pathlib import Path
import tempfile
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:6199')
    parser.add_argument('--advertised-host', default='192.168.31.9')
    parser.add_argument('--screenshots', default=str(Path(tempfile.gettempdir()) / 'crosslan-qr'))
    args = parser.parse_args()
    output = Path(args.screenshots)
    output.mkdir(parents=True, exist_ok=True)
    decoder = Path(__file__).resolve().parents[2] / 'node_modules' / 'jsqr' / 'dist' / 'jsQR.js'
    parsed = urlparse(args.url)
    port = f':{parsed.port}' if parsed.port else ''
    expected_url = f'{parsed.scheme}://{args.advertised_host}{port}/'

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True)
        try:
            def exercise(locale, size, theme, http_fallback=False):
                context = browser.new_context(
                    viewport=size, locale=locale, color_scheme=theme,
                    permissions=['clipboard-read', 'clipboard-write'], service_workers='block'
                )
                try:
                    if http_fallback:
                        context.add_init_script("Object.defineProperty(window, 'isSecureContext', { value: false })")
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(args.url)
                    page.wait_for_load_state('networkidle')
                    expect(page.get_by_text('在线' if locale.startswith('zh') else 'Online', exact=True)).to_be_visible()
                    button = page.locator('.share-toolbar-button:visible, .mobile-share-button:visible')
                    expect(button).to_be_visible()
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                    button.click()
                    modal = page.get_by_role('dialog')
                    expect(modal).to_be_visible()
                    image = modal.locator('.share-qr img')
                    expect(image).to_be_visible()
                    page.wait_for_function("document.querySelector('.share-qr img')?.naturalWidth > 0")
                    expect(modal.locator('#share-address')).to_have_value(expected_url)
                    page.add_script_tag(path=str(decoder))
                    decoded = image.evaluate('''image => {
                        const canvas = document.createElement('canvas');
                        canvas.width = image.naturalWidth;
                        canvas.height = image.naturalHeight;
                        const context = canvas.getContext('2d');
                        context.drawImage(image, 0, 0);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
                        return jsQR(pixels.data, canvas.width, canvas.height)?.data;
                    }''')
                    assert decoded == expected_url, decoded
                    assert '127.0.0.1' not in decoded and 'Token' not in decoded
                    bounds = modal.bounding_box()
                    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= size['width']
                    assert modal.evaluate('dialog => dialog.scrollWidth <= dialog.clientWidth')
                    page.screenshot(path=str(output / f'qr-{locale}-{theme}-{size["width"]}.png'), full_page=True, animations='disabled')

                    modal.get_by_role('button', name='复制地址' if locale.startswith('zh') else 'Copy address').click()
                    expect(modal.get_by_role('status')).to_have_text('已复制' if locale.startswith('zh') else 'Copied')
                    assert page.evaluate('navigator.clipboard.readText()') == expected_url
                    for _ in range(6):
                        page.keyboard.press('Tab')
                        assert modal.evaluate('dialog => dialog.contains(document.activeElement) || document.activeElement === document.body')
                    modal.locator('#share-address').focus()
                    page.keyboard.press('Escape')
                    expect(modal).to_have_count(0)
                    expect(button).to_be_focused()

                    button.click()
                    expect(page.get_by_role('dialog')).to_be_visible()
                    page.mouse.click(4, 4)
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    button.click()
                    modal = page.get_by_role('dialog')
                    modal.get_by_role('button', name='关闭' if locale.startswith('zh') else 'Close', exact=True).click()
                    expect(page.get_by_role('dialog')).to_have_count(0)
                    assert not errors, errors
                finally:
                    context.close()

            exercise('zh-CN', {'width': 1280, 'height': 850}, 'light')
            exercise('en-US', {'width': 375, 'height': 812}, 'dark')
            exercise('zh-CN', {'width': 320, 'height': 568}, 'light', http_fallback=True)
            print(f'QR decode, copying, focus, closing, and desktop/mobile layout tests passed. Screenshots: {output}')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
