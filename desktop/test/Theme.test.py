"""Run against the desktop Vite server with Playwright and a mocked Tauri backend."""

import argparse
from pathlib import Path
import re
import tempfile

from playwright.sync_api import expect, sync_playwright


BOOTSTRAP = r"""
import { mockIPC, mockWindows } from '__API__/mocks.js';
import { emit } from '__API__/event.js';
window.isTauri = true;
window.themeCommands = [];
window.failConfigSave = false;
mockWindows('main');
mockIPC((command, args) => {
  window.themeCommands.push({ command, args });
  if (command === 'get_desktop_config') {
    return JSON.parse(localStorage.getItem('test-config') || JSON.stringify({
      port: 6100, saveDir: 'C:\\Users\\Test\\Downloads\\CrossLAN',
      networkAdapter: 'auto', locale: 'zh-CN'
    }));
  }
  if (command === 'list_network_adapters') {
    return [{ id: 'wifi', name: 'Wi-Fi', ip: '192.168.31.9' }];
  }
  if (command === 'get_launch_state' || command === 'save_desktop_config') {
    if (command === 'save_desktop_config') {
      if (window.failConfigSave) throw new Error('Test save failure');
      localStorage.setItem('test-config', JSON.stringify(args.config));
    }
    return { ready: true, url: 'http://192.168.31.9:6100', error: null };
  }
  if (command === 'plugin:window|set_theme') return null;
  if (command === 'plugin:dialog|open') return 'C:\\Users\\Test\\Downloads\\New Folder';
  throw new Error(`Unexpected Tauri command: ${command}`);
}, { shouldMockEvents: true });
window.openTestConfig = () => emit('crosslan://open-config');
window.emitTestLaunch = (state = {
  ready: true, url: 'http://192.168.31.9:6100', error: null
}) => emit('crosslan://launch-state', state);
"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:1420')
    parser.add_argument('--screenshots', default=str(Path(tempfile.gettempdir()) / 'crosslan-theme'))
    args = parser.parse_args()
    output = Path(args.screenshots)
    output.mkdir(parents=True, exist_ok=True)
    api_path = Path(__file__).resolve().parents[2] / 'node_modules' / '@tauri-apps' / 'api'
    bootstrap = BOOTSTRAP.replace('__API__', '/@fs/' + api_path.as_posix())

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel='msedge', headless=True, args=['--no-proxy-server'])
        try:
            page = browser.new_page(viewport={'width': 720, 'height': 680}, color_scheme='light')
            errors = []
            requests = []
            page.on('request', lambda request: requests.append(request.url))
            page.on('pageerror', lambda error: errors.append(str(error)))

            def mock_main(route):
                response = route.fetch()
                route.fulfill(response=response, body=bootstrap + '\n' + response.text())

            page.route('**/src/main.ts*', mock_main)
            page.goto(args.url)
            page.wait_for_load_state('networkidle')
            assert not errors, errors
            assert page.evaluate("typeof window.openTestConfig === 'function'"), requests

            def open_config():
                page.evaluate('window.openTestConfig()')
                expect(page.locator('#settings-form')).to_be_visible()

            def check_theme(theme, background):
                expect(page.locator('html')).to_have_attribute('data-theme', theme)
                expect(page.locator('html')).to_have_css('background-color', background)
                expect(page.locator(f'input[name="theme"][value="{theme}"]')).to_be_checked()

            def choose_theme(theme):
                page.locator(f'.theme-control label:has(input[value="{theme}"])').click()

            def choose_locale(value):
                picker = page.locator('#locale')
                picker.locator('summary').click()
                picker.locator(f'label:has(input[value="{value}"])').click(delay=150)
                expect(picker.locator(f'input[value="{value}"]')).to_be_checked()
                expect(picker).not_to_have_attribute('open', '')
                expect(picker.locator('summary')).to_be_focused()

            def check_language_panel(name):
                picker = page.locator('#locale')
                picker.locator('summary').click()
                panel = picker.locator('.ui-choice-panel')
                expect(panel).to_be_visible()
                expect(panel).to_have_css('border-radius', '10px')
                expect(panel).to_have_css('padding', '0px')
                expect(panel).to_have_css('border-top-width', '0px')
                expect(panel).to_have_attribute('style', re.compile('choice-shift'))
                bounds = panel.bounding_box()
                trigger = picker.locator('summary').bounding_box()
                assert bounds['width'] == trigger['width'] and bounds['x'] == trigger['x']
                rows = [row.bounding_box() for row in picker.locator('.ui-option-row').all()]
                for previous, current in zip(rows, rows[1:]):
                    assert abs(previous['y'] + previous['height'] - current['y']) < 1
                viewport = page.viewport_size
                assert 8 <= bounds['x'] and bounds['x'] + bounds['width'] <= viewport['width'] - 8
                assert 0 <= bounds['y'] and bounds['y'] + bounds['height'] <= viewport['height']
                page.screenshot(path=str(output / f'language-{name}.png'), full_page=True, animations='disabled')
                page.keyboard.press('Escape')
                expect(picker.locator('summary')).to_be_focused()
                expect(picker).not_to_have_attribute('open', '')

            def check_layout():
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                for control in page.locator('#save, #quit, #choose-save-dir, #locale summary').all():
                    expect(control).to_have_css('text-align', 'center')
                    assert control.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                quit_box = page.locator('#quit').bounding_box()
                save_box = page.locator('#save').bounding_box()
                assert quit_box['y'] == save_box['y'] and quit_box['height'] == save_box['height'] == 42, (quit_box, save_box)
                assert quit_box['x'] + quit_box['width'] <= save_box['x']
                for locator in page.locator('.theme-control span').all():
                    assert locator.evaluate('(el) => el.scrollWidth <= el.clientWidth')
                bounds = [locator.bounding_box() for locator in page.locator('.theme-control label').all()]
                assert max(box['width'] for box in bounds) - min(box['width'] for box in bounds) < 1
                assert all(bounds[index]['x'] + bounds[index]['width'] <= bounds[index + 1]['x']
                           for index in range(len(bounds) - 1))
                if page.viewport_size['width'] > 620:
                    wide = [page.locator(selector).bounding_box() for selector in ('#network-adapter', '#save-dir', '.theme-control')]
                    narrow = [page.locator(selector).bounding_box() for selector in ('#port', '#choose-save-dir', '#locale summary')]
                    assert len({box['width'] for box in wide}) == len({box['width'] for box in narrow}) == 1
                    assert len({box['x'] for box in wide}) == len({box['x'] for box in narrow}) == 1

            open_config()
            for control in page.locator('.ui-surface, #port, #network-adapter, #save-dir, .theme-control span, #save').all():
                expect(control).to_have_css('border-radius', '10px')
            expect(page.locator('.theme-control')).to_have_css('border-radius', '10px')
            expect(page.locator('#service-status')).to_have_text('服务运行中')
            expect(page.locator('#service-status')).to_have_css('border-radius', '10px')
            expect(page.locator('#service-status')).to_have_css('justify-content', 'center')
            expect(page.locator('#service-status')).to_have_css('cursor', 'default')
            assert page.locator('#service-status').bounding_box()['height'] == 40
            command_widths = [button.bounding_box()['width'] for button in page.locator('#save, #quit, #choose-save-dir').all()]
            assert command_widths == [164, 164, 164]
            check_theme('system', 'rgb(244, 247, 246)')
            choose_theme('dark')
            check_theme('dark', 'rgb(20, 25, 24)')
            check_layout()
            page.screenshot(path=str(output / 'dark.png'), full_page=True, animations='disabled')
            check_language_panel('dark')
            assert page.evaluate("window.themeCommands.filter(c => c.command === 'plugin:window|set_theme').at(-1).args.value") == 'dark'
            page.emulate_media(color_scheme='dark')
            choose_theme('light')
            check_theme('light', 'rgb(244, 247, 246)')
            page.screenshot(path=str(output / 'light.png'), full_page=True, animations='disabled')
            check_language_panel('light')
            choose_theme('system')
            check_theme('system', 'rgb(20, 25, 24)')
            page.emulate_media(color_scheme='light')
            check_theme('system', 'rgb(244, 247, 246)')
            assert page.evaluate("window.themeCommands.filter(c => c.command === 'plugin:window|set_theme').at(-1).args.value") is None

            choose_theme('dark')
            page.locator('#port').fill('6200')
            page.locator('#network-adapter').select_option('wifi')
            page.locator('#choose-save-dir').click()
            expect(page.locator('#save-dir')).to_have_value(r'C:\Users\Test\Downloads\New Folder')
            choose_locale('en-US')
            assert page.evaluate("window.themeCommands.filter(c => c.command === 'save_desktop_config').length") == 0
            page.locator('#save').click()
            expect(page.locator('.launch-screen')).to_be_visible()
            saved = page.evaluate("JSON.parse(localStorage.getItem('test-config'))")
            assert saved['theme'] == 'dark'
            assert saved['port'] == 6200 and saved['networkAdapter'] == 'wifi' and saved['locale'] == 'en-US'
            assert saved['saveDir'] == r'C:\Users\Test\Downloads\New Folder'
            page.reload(wait_until='networkidle')
            open_config()
            expect(page.locator('#locale summary')).to_have_text('English')
            expect(page.locator('#service-status')).to_have_text('Service running')
            check_theme('dark', 'rgb(20, 25, 24)')

            page.set_viewport_size({'width': 600, 'height': 580})
            check_layout()
            page.screenshot(path=str(output / 'compact-dark.png'), full_page=True, animations='disabled')
            page.evaluate("localStorage.setItem('test-config', JSON.stringify({ ...JSON.parse(localStorage.getItem('test-config')), locale: 'en-US' }))")
            page.reload(wait_until='networkidle')
            open_config()
            expect(page.get_by_role('group', name='Appearance')).to_be_visible()
            page.set_viewport_size({'width': 720, 'height': 680})
            check_layout()
            page.screenshot(path=str(output / 'english-dark.png'), full_page=True, animations='disabled')
            page.set_viewport_size({'width': 360, 'height': 640})
            check_layout()
            check_language_panel('english-compact')
            page.set_viewport_size({'width': 720, 'height': 680})

            locale_trigger = page.locator('#locale summary')
            locale_trigger.focus()
            page.keyboard.press('ArrowDown')
            expect(page.locator('input[name="locale"][value="en-US"]')).to_be_focused()
            page.keyboard.press('ArrowUp')
            expect(page.locator('input[name="locale"][value="zh-CN"]')).to_be_checked()
            page.keyboard.press('Enter')
            expect(locale_trigger).to_be_focused()
            expect(page.locator('#locale')).not_to_have_attribute('open', '')
            locale_trigger.click()
            page.get_by_role('heading', name='CrossLAN settings').click()
            expect(page.locator('#locale')).not_to_have_attribute('open', '')
            locale_trigger.focus()
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Space')
            expect(locale_trigger).to_be_focused()
            expect(page.locator('#locale')).not_to_have_attribute('open', '')

            page.evaluate('window.failConfigSave = true')
            page.locator('#save').click()
            expect(page.locator('#settings-status')).to_contain_text('Test save failure')
            page.evaluate('window.emitTestLaunch()')
            expect(page.locator('#settings-form')).to_be_visible()
            expect(page.locator('#save')).to_be_enabled()
            page.evaluate("window.emitTestLaunch({ ready: false, url: '', error: 'Test service error' })")
            expect(page.locator('#service-status')).to_have_text('Service error')
            expect(page.locator('#service-status')).to_have_attribute('data-tone', 'negative')
            expect(page.locator('#settings-form')).to_be_visible()
            assert not errors, errors
            print(f'Theme UI tests passed. Screenshots: {output}')
        finally:
            browser.close()


if __name__ == '__main__':
    main()
