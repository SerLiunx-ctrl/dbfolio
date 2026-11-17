const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const url = process.env.DBFOLIO_FIXTURE_URL || 'http://127.0.0.1:1425';

function luminance(rgb) {
  const [r, g, b] = rgb.map(value => {
    const s = Number(value) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

async function checkContrast(control, label) {
  // Read the final fill, after Fluent hover and dialog-opening transitions.
  await control.evaluate(async node => {
    await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
  });
  const [color, fill] = await control.evaluate(node => {
    const rgba = css => css.match(/[\d.]+/g).map(Number);
    const layers = [];
    for (let element = node; element; element = element.parentElement) {
      layers.push(rgba(getComputedStyle(element).backgroundColor));
    }
    const fill = layers.reverse().reduce((under, [r, g, b, alpha = 1]) =>
      [r, g, b].map((v, i) => v * alpha + under[i] * (1 - alpha)), [255, 255, 255]);
    return [rgba(getComputedStyle(node).color).slice(0, 3), fill];
  });
  const a = luminance(color), b = luminance(fill);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert(ratio >= 4.5, label + ' measured ' + ratio);
  return ratio;
}

async function checkDialogButton(page, dialog, label) {
  await dialog.waitFor();
  const close = dialog.getByRole('button', { name: '关闭', exact: true });
  await page.mouse.move(0, 0);
  const ratios = [await checkContrast(close, label + ' rest')];
  await close.hover();
  ratios.push(await checkContrast(close, label + ' hover'));
  await page.mouse.move(0, 0);
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  assert(await close.evaluate(node => node === document.activeElement), label + ' keyboard focus');
  ratios.push(await checkContrast(close, label + ' focus'));
  console.log(label, ratios.map(r => r.toFixed(2)).join(' / '));
}

async function checkTheme(page, theme, accent) {
  const mode = theme === 'light' ? '' : '&' + theme;
  await page.goto(url + '/scripts/fixtures/settings-preview.html?category=appearance' + mode);
  const picker = page.locator('input[type=color]');
  await picker.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  if (await picker.inputValue() !== accent) {
    await picker.fill(accent);
    await page.getByRole('button', { name: '应用配色', exact: true }).click();
    await page.waitForFunction(expected => window.settings.get('ui_accent') === expected, accent);
  }
  const preview = page.getByText('强调色预览', { exact: true });
  const previewRatio = await checkContrast(preview, theme + ' preview');
  console.log(theme, accent, 'preview', previewRatio.toFixed(2));
  const border = await preview.evaluate(node => getComputedStyle(node).borderTopColor);
  assert.equal(border, 'rgb(' + accent.slice(1).match(/../g).map(v => parseInt(v, 16)).join(', ') + ')');
  await page.evaluate(() => window.dispatchEvent(new Event('dw:about')));
  await checkDialogButton(page, page.getByRole('dialog', { name: '关于 DBFolio' }), theme + ' ' + accent + ' about');
  await page.goto(url + '/scripts/fixtures/task-center-layout.html?theme=' + theme + '&accent=' + encodeURIComponent(accent));
  await page.locator('.dw-task-trigger').click();
  await checkDialogButton(page, page.getByRole('dialog', { name: '任务中心' }), theme + ' ' + accent + ' tasks');
}

async function checkLayout(page, width, zoom) {
  await page.setViewportSize({ width, height: 720 });
  await page.goto(url + '/scripts/fixtures/settings-preview.html?category=layout');
  const main = page.getByRole('main', { name: '布局与缩放' });
  // The shell reserves 300px for the dock, and scales only the remaining workspace.
  await main.evaluate((node, scale) => {
    const area = node.parentElement.parentElement;
    Object.assign(area.style, { marginLeft: '300px', width: (innerWidth - 300) / scale + 'px',
      height: (innerHeight - 31) / scale + 'px', transform: 'scale(' + scale + ')', transformOrigin: 'top left' });
  }, zoom);
  const combo = main.getByRole('combobox', { name: '页签最多数量' });
  await combo.scrollIntoViewIfNeeded();
  const [control, body] = await Promise.all([combo.boundingBox(), main.boundingBox()]);
  assert(control.x >= body.x && control.x + control.width <= Math.min(width, body.x + body.width) + 1, 'dropdown must fit: ' + JSON.stringify({width, zoom, control, body}));
  await combo.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  assert.equal((await combo.innerText()).trim(), '10 个');
  const slider = main.getByRole('slider', { name: /同侧上下比例/ });
  assert.equal(await slider.inputValue(), '32');
  await slider.press('ArrowRight');
  const newValue = await slider.inputValue();
  assert(Number(newValue) > 32);
  assert.equal(await main.getByRole('slider', { name: '同侧上下比例（上方面板 ' + newValue + '%）' }).count(), 1);
  assert.equal(await page.evaluate(() => Number(window.settings.get('ui_sidebar_split')) * 100), Number(newValue));
  await slider.press('ArrowLeft');
  assert.equal(await slider.inputValue(), '32');
  console.log('Layout OK', width, zoom, control.width);
}

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    for (const theme of ['light', 'dark', 'oled']) {
      for (const accent of ['#0f6cbd', '#ffff00']) await checkTheme(page, theme, accent);
    }
    for (const width of [900, 1024, 1280]) {
      for (const zoom of [1, 2]) await checkLayout(page, width, zoom);
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
