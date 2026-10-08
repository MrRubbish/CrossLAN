"""Test webpage settings, static status affordances, and responsive header layout."""

import argparse
from pathlib import Path
import re
import tempfile

from playwright.sync_api import expect, sync_playwright


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:6199')
    parser.add_argument('--screenshots', default=str(Path(tempfile.gettempdir()) / 'crosslan-toolbar'))
    args = parser.parse_args()
    output = Path(args.screenshots)
    output.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True)
        try:
            context = browser.new_context(viewport={'width': 1280, 'height': 850}, locale='zh-CN', service_workers='block')
            page = context.new_page()
            errors = []
            sockets = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.on('websocket', lambda socket: sockets.append(socket))
            page.goto(args.url)
            page.wait_for_load_state('networkidle')
            expect(page.locator('.toolbar-connection')).to_have_text('在线')
            picker = page.locator('.locale-picker')
            locale = picker.locator('summary')
            theme = page.locator('.toolbar-theme')
            html = page.locator('html')
            expect(picker.locator('input[value="system"]')).to_be_checked()
            expect(locale).to_have_text('自动')
            expect(theme).to_have_attribute('data-preference', 'system')
            expect(theme).to_have_text('系统')
            assert page.locator('select[name="theme"]').count() == 0
            expect(html).to_have_attribute('lang', 'zh-CN')
            assert page.locator('.toolbar-status button, .toolbar-status select, .toolbar-status a').count() == 0
            expect(page.locator('.toolbar-status')).to_have_css('cursor', 'default')
            expect(page.locator('.share-toolbar-button')).to_have_css('cursor', 'pointer')
            expect(page.locator('.mobile-share-button')).not_to_be_visible()

            def choose_locale(value):
                if not picker.evaluate('(element) => element.open'):
                    locale.click()
                picker.locator(f'label:has(input[value="{value}"])').click()
                expect(picker.locator(f'input[value="{value}"]')).to_be_checked()
                expect(picker).not_to_have_attribute('open', '')
                expect(locale).to_be_focused()

            def check_status_badges():
                for badge in page.locator('.toolbar-badge').all():
                    expect(badge).to_have_css('cursor', 'default')
                    expect(badge).to_have_css('border-top-style', 'solid')
                    expect(badge).to_have_css('border-radius', '10px')
                    expect(badge).to_have_css('justify-content', 'center')
                    assert badge.bounding_box()['height'] == theme.bounding_box()['height'] == 40
                    background = badge.evaluate('(element) => getComputedStyle(element).backgroundColor')
                    badge.hover()
                    expect(badge).to_have_css('background-color', background)
                    contrast = badge.evaluate("""element => {
                        const color = value => value.match(/[\\d.]+/g).map(Number);
                        const style = getComputedStyle(element);
                        const base = color(getComputedStyle(document.querySelector('main')).backgroundColor);
                        const fill = color(style.backgroundColor);
                        const alpha = fill[3] ?? 1;
                        const background = fill.slice(0, 3).map((value, i) => value * alpha + base[i] * (1 - alpha));
                        const luminance = rgb => rgb.slice(0, 3).map(value => {
                            const channel = value / 255;
                            return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
                        }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
                        const text = luminance(color(style.color));
                        const surface = luminance(background);
                        return { alpha, ratio: (Math.max(text, surface) + 0.05) / (Math.min(text, surface) + 0.05) };
                    }""")
                    assert contrast['alpha'] >= 0.08, 'Statuses must have a visible filled background'
                    assert contrast['ratio'] >= 4.5, contrast

            check_status_badges()
            for control in page.locator('.toolbar-control').all():
                page.get_by_role('heading', name='CrossLAN', exact=True).hover()
                background = control.evaluate('(element) => getComputedStyle(element).backgroundColor')
                control.hover()
                expect(control).not_to_have_css('background-color', background)
            page.get_by_role('heading', name='CrossLAN', exact=True).hover()
            page.screenshot(path=str(output / 'desktop-light.png'), full_page=True, animations='disabled')

            locale.click()
            expect(picker.get_by_role('group', name='界面语言')).to_be_visible()
            page.get_by_role('heading', name='CrossLAN', exact=True).hover()
            expect(picker.locator('.ui-choice-panel')).to_have_css('width', '144px')
            expect(picker.locator('.ui-choice-panel')).to_have_css('border-radius', '10px')
            expect(picker.locator('.ui-choice-panel')).to_have_css('padding', '0px')
            expect(picker.locator('.ui-choice-panel')).to_have_css('border-top-width', '0px')
            for option in picker.locator('.ui-option-row').all():
                expect(option).to_have_css('border-radius', '10px')
                expect(option).to_have_css('border-top-width', '0px')
                expect(option).to_have_css('justify-content', 'center')
            page.screenshot(path=str(output / 'desktop-language-light.png'), full_page=True, animations='disabled')
            header = page.locator('header').first.bounding_box()
            panel = picker.locator('.ui-choice-panel').bounding_box()
            header_clip = {
                'x': header['x'] - 12, 'y': header['y'],
                'width': header['width'] + 24, 'height': panel['y'] + panel['height'] - header['y'] + 12
            }
            page.screenshot(path=str(output / 'rectangle-header-light.png'), animations='disabled', clip=header_clip)
            base_background = theme.evaluate('(element) => getComputedStyle(element).backgroundColor')
            theme.hover()
            expect(theme).not_to_have_css('background-color', base_background)
            page.screenshot(path=str(output / 'rectangle-header-hover.png'), animations='disabled', clip=header_clip)
            page.keyboard.press('Escape')
            expect(locale).to_be_focused()
            expect(picker).not_to_have_attribute('open', '')
            locale.click()
            page.get_by_role('heading', name='CrossLAN', exact=True).click()
            expect(picker).not_to_have_attribute('open', '')
            choose_locale('en-US')
            expect(html).to_have_attribute('lang', 'en-US')
            expect(page.get_by_role('heading', name='Select target device')).to_be_visible()
            expect(page.locator('.toolbar-connection')).to_have_text('Online')
            expect(page.get_by_text(re.compile(r'^Current: '))).to_be_visible()
            assert page.evaluate("localStorage.getItem('crosslan:locale')") == 'en-US'
            assert locale.get_attribute('title') == 'Interface language: English'
            theme.focus()
            page.keyboard.press('Space')
            expect(theme).to_have_text('Light')
            expect(html).to_have_attribute('data-theme', 'light')
            theme_width = theme.bounding_box()['width']
            theme.click()
            expect(theme).to_have_text('Dark')
            assert theme.bounding_box()['width'] == theme_width
            expect(html).to_have_attribute('data-theme', 'dark')
            check_status_badges()
            page.locator('.share-toolbar-button').click()
            expect(page.get_by_role('dialog').get_by_role('heading', name='Open via QR code')).to_be_visible()
            page.keyboard.press('Escape')
            assert len(sockets) == 1, 'UI preference changes must not reconnect signaling'
            page.screenshot(path=str(output / 'desktop-english-dark.png'), full_page=True, animations='disabled')

            page.reload(wait_until='networkidle')
            expect(picker.locator('input[value="en-US"]')).to_be_checked()
            expect(theme).to_have_attribute('data-preference', 'dark')
            expect(html).to_have_attribute('lang', 'en-US')
            expect(html).to_have_attribute('data-theme', 'dark')
            choose_locale('system')
            expect(html).to_have_attribute('lang', 'zh-CN')
            expect(theme).to_have_attribute('data-preference', 'dark')
            page.evaluate("Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }); window.dispatchEvent(new Event('languagechange'))")
            expect(html).to_have_attribute('lang', 'en-US')
            choose_locale('zh-CN')
            page.evaluate("Object.defineProperty(navigator, 'language', { value: 'ja-JP', configurable: true }); window.dispatchEvent(new Event('languagechange'))")
            expect(html).to_have_attribute('lang', 'zh-CN')
            theme.focus()
            page.keyboard.press('Enter')
            expect(theme).to_have_text('系统')
            expect(theme).to_have_attribute('data-preference', 'system')
            assert page.evaluate("localStorage.getItem('crosslan:theme')") == 'system'
            assert html.get_attribute('data-theme') is None
            page.emulate_media(color_scheme='dark')
            expect(html).to_have_css('color-scheme', 'dark')

            def check_layout(width, height):
                page.set_viewport_size({'width': width, 'height': height})
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                controls = page.locator('.toolbar-control:visible').all()
                bounds = [control.bounding_box() for control in controls]
                assert all(bounds[index]['x'] + bounds[index]['width'] <= bounds[index + 1]['x']
                           for index in range(len(bounds) - 1))
                for control in controls:
                    assert control.evaluate('(element) => element.clientHeight === 38')
                    expect(control).to_have_css('border-radius', '10px')
                    expect(control).to_have_css('justify-content', 'center')
                    assert control.evaluate('(element) => element.scrollWidth <= element.clientWidth')
                widths = [control.bounding_box()['width'] for control in page.locator('.toolbar-theme, .locale-picker > summary, .toolbar-badge').all()]
                actions_box = page.locator('.toolbar-actions').bounding_box()
                assert len(set(widths)) == 1 and widths[0] == (actions_box['width'] - (12 if width <= 640 else 64)) / 2
                qr = page.locator('.mobile-share-button' if width <= 640 else '.share-toolbar-button')
                assert qr.bounding_box()['width'] == 40
                if width <= 640:
                    expect(page.locator('.share-toolbar-button')).not_to_be_visible()
                    title = page.get_by_role('heading', name='CrossLAN', exact=True).bounding_box()
                    qr_box = qr.bounding_box()
                    assert qr_box['x'] > title['x'] and abs(qr_box['y'] - title['y']) < 12
                for item in page.locator('.toolbar-status > span').all():
                    assert item.evaluate('(element) => element.scrollWidth <= element.clientWidth')
                status_box = page.locator('.toolbar-status').bounding_box()
                actions_box = page.locator('.toolbar-actions').bounding_box()
                theme_box = theme.bounding_box()
                protocol_box = page.locator('.toolbar-protocol').bounding_box()
                assert theme_box['x'] == protocol_box['x']
                assert locale.bounding_box()['x'] == page.locator('.toolbar-connection').bounding_box()['x']
                assert (actions_box['x'] + actions_box['width'] <= status_box['x']
                        or actions_box['y'] + actions_box['height'] <= status_box['y'])
                check_status_badges()
                page.screenshot(path=str(output / f'compact-{width}.png'), full_page=True, animations='disabled')
                locale.click()
                panel = picker.locator('.ui-choice-panel')
                expect(panel).to_be_visible()
                expect(panel).to_have_attribute('style', re.compile('choice-shift'))
                page.wait_for_function("""() => {
                    const bounds = document.querySelector('.locale-picker .ui-choice-panel').getBoundingClientRect();
                    return bounds.left >= 8 && bounds.right <= innerWidth - 8
                        && bounds.top >= 0 && bounds.bottom <= innerHeight;
                }""")
                menu_box = panel.bounding_box()
                trigger_box = locale.bounding_box()
                assert menu_box['width'] == trigger_box['width'] and menu_box['x'] == trigger_box['x']
                assert abs(menu_box['y'] - trigger_box['y'] - trigger_box['height']) < 1
                options = [option.bounding_box() for option in picker.locator('.ui-option-row').all()]
                for previous, current in zip(options, options[1:]):
                    assert abs(previous['y'] + previous['height'] - current['y']) < 1
                assert menu_box['x'] >= 8 and menu_box['x'] + menu_box['width'] <= width - 8
                assert menu_box['y'] >= 0 and menu_box['y'] + menu_box['height'] <= height
                page.screenshot(path=str(output / f'compact-language-{width}.png'), full_page=True, animations='disabled')
                page.keyboard.press('Escape')

            check_layout(768, 850)
            check_layout(375, 812)
            limit = page.locator('input[type="number"]')
            expect(limit).to_be_disabled()
            page.locator('label:has(input[name="bandwidth"][value="manual"])').click()
            expect(limit).to_be_enabled()
            expect(limit).to_have_value('100')
            segments = [label.bounding_box() for label in page.locator('.ui-segments label').all()]
            assert segments[0]['width'] == segments[1]['width']
            page.locator('label:has(input[name="bandwidth"][value="unlimited"])').click()
            expect(limit).to_be_disabled()
            page.emulate_media(color_scheme='light')
            page.screenshot(path=str(output / 'mobile-light.png'), full_page=True, animations='disabled')
            page.emulate_media(color_scheme='dark')
            choose_locale('en-US')
            check_layout(320, 568)
            choose_locale('system')
            locale.focus()
            page.keyboard.press('ArrowDown')
            expect(picker.locator('input[value="system"]')).to_be_focused()
            page.keyboard.press('ArrowDown')
            expect(picker.locator('input[value="zh-CN"]')).to_be_checked()
            assert picker.evaluate('(element) => element.open')
            page.keyboard.press('Enter')
            expect(picker.locator('input[value="zh-CN"]')).to_be_checked()
            expect(html).to_have_attribute('lang', 'zh-CN')
            expect(locale).to_be_focused()
            expect(locale).to_have_css('outline-style', 'solid')
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Tab')
            expect(picker).not_to_have_attribute('open', '')
            locale.focus()
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Space')
            expect(locale).to_be_focused()
            expect(picker).not_to_have_attribute('open', '')
            assert not errors, errors
            context.close()

            fresh = browser.new_context(viewport={'width': 375, 'height': 812}, locale='en-US', service_workers='block')
            fresh_page = fresh.new_page()
            fresh_page.add_init_script("""window.WebSocket = class extends EventTarget {
                static OPEN = 1;
                readyState = 3;
                close() {}
                send() {}
            };""")
            fresh_page.goto(args.url)
            fresh_page.wait_for_load_state('networkidle')
            expect(fresh_page.locator('.toolbar-connection')).to_have_text('Offline')
            expect(fresh_page.locator('.toolbar-connection')).not_to_have_class(re.compile('is-online'))
            fresh_page.screenshot(path=str(output / 'mobile-offline.png'), full_page=True, animations='disabled')
            expect(fresh_page.locator('input[name="locale"][value="system"]')).to_be_checked()
            expect(fresh_page.locator('html')).to_have_attribute('lang', 'en-US')
            fresh_page.evaluate("localStorage.setItem('crosslan:locale', 'invalid')")
            fresh_page.reload(wait_until='networkidle')
            expect(fresh_page.locator('input[name="locale"][value="system"]')).to_be_checked()
            expect(fresh_page.locator('html')).to_have_attribute('lang', 'en-US')
            fresh.close()
            managed = browser.new_context(viewport={'width': 375, 'height': 812}, locale='zh-CN', service_workers='block')
            managed.route('**/api/health', lambda route: route.fulfill(json={
                'ok': True, 'name': 'CrossLAN', 'deploymentMode': 'node', 'desktopManaged': True
            }))
            managed_page = managed.new_page()
            storage_requests = []
            managed_page.on('request', lambda request: storage_requests.append(request.url) if '/api/storage' in request.url else None)
            managed_page.goto(args.url, wait_until='networkidle')
            expect(managed_page.locator('.toolbar-connection')).to_have_text('在线')
            expect(managed_page.locator('input[placeholder="/data/CrossLAN"]')).to_have_count(0)
            assert not storage_requests, 'Desktop-managed browser clients must not load the service host save path'
            managed_page.screenshot(path=str(output / 'mobile-desktop-managed.png'), full_page=True, animations='disabled')
            managed.close()
            print(f'Toolbar, language persistence, system updates, independent settings, and responsive layout tests passed. Screenshots: {output}')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
