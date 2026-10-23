/**
 * Jollyvideo in a real Sharkord: copied into Sharkord's own end-to-end suite
 * (packages/e2e/tests) by e2e/run.sh, which also installs and enables the
 * plugin and points it at a yt-dlp stand-in.
 */
import { TestId } from '@sharkord/shared';
import type { Page } from '@playwright/test';
import { expect, loginAs, test } from './fixtures';

test.use({
  viewport: { width: 1280, height: 760 },
  launchOptions: {
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  },
  permissions: ['microphone', 'camera']
});
// a retry would find the server's player as the first try left it
test.describe.configure({ retries: 0 });

/** the widest picture any video element shows, and how far it has played */
const streamVideo = (page: Page) =>
  page.evaluate(() => {
    const videos = [...document.querySelectorAll('video')].filter((video) => video.videoWidth > 0);
    const video = videos.sort((a, b) => b.videoWidth - a.videoWidth)[0];
    return video ? { width: video.videoWidth, time: video.currentTime } : { width: 0, time: 0 };
  });

/** frames arrive: the stream card's video has a picture and moves on */
const expectFrames = async (page: Page) => {
  await expect.poll(async () => (await streamVideo(page)).width, { timeout: 30_000 }).toBeGreaterThan(0);
  const before = (await streamVideo(page)).time;
  await expect.poll(async () => (await streamVideo(page)).time, { timeout: 15_000 }).toBeGreaterThan(before + 1);
};

test('watches a video together in a voice channel', async ({ page }) => {
  test.setTimeout(180_000);
  await loginAs(page, 'testowner', 'password123');

  await page.getByTestId(TestId.CHANNEL_ITEM).filter({ hasText: 'Voice' }).first().click({ force: true });
  const button = page.getByRole('button', { name: 'Watch together' });
  await expect(button).toBeVisible({ timeout: 30_000 });

  await button.click();
  const panel = page.getByRole('dialog', { name: 'Watch together' });
  const add = async (query: string) => {
    await panel.getByRole('textbox', { name: 'YouTube link or search' }).fill(query);
    await panel.getByRole('button', { name: 'Add' }).click();
    await expect(panel.getByRole('textbox', { name: 'YouTube link or search' })).toHaveValue('', { timeout: 30_000 });
  };
  await add('sunset');

  // playing, with its length from the lookup
  await expect(panel.getByText(/^0:\d\d \/ 2:00$/)).toBeVisible({ timeout: 60_000 });
  await expect(panel.getByRole('paragraph')).toHaveText('Sunset over the bay');
  await expectFrames(page);

  // two more in the queue, the next one downloaded
  await add('harbor');
  await add('night');
  const rows = panel.getByRole('listitem');
  await expect(rows).toHaveText([/Harbor lights/, /Night drive/]);
  await expect(rows.filter({ hasText: '2:00' })).toHaveCount(2, { timeout: 30_000 });
  // the members list on the right is left out
  await page.screenshot({ path: process.env.JOLLYVIDEO_SCREENSHOT ?? 'jollyvideo.png', clip: { x: 0, y: 0, width: 1040, height: 760 } });

  // dragged by its handle to the top
  const grip = panel.getByRole('button', { name: 'Move Night drive', exact: true });
  const from = (await grip.boundingBox())!;
  const top = (await rows.first().boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, top.y + 2, { steps: 8 });
  await page.mouse.up();
  await expect(rows).toHaveText([/Night drive/, /Harbor lights/]);
  // and one step back down with the keyboard, keeping the focus
  await grip.focus();
  await grip.press('ArrowDown');
  await expect(rows).toHaveText([/Harbor lights/, /Night drive/]);
  await expect(grip).toBeFocused();
  // the server has the same order: the panel shows it once more after a reopen
  await page.keyboard.press('Escape');
  await button.click();
  await expect(rows).toHaveText([/Harbor lights/, /Night drive/]);

  // a seek swaps the stream to a new ffmpeg: Sharkord has to pick up the new producers
  const slider = panel.getByRole('slider', { name: 'Position' });
  await slider.focus();
  const before = Number(await slider.getAttribute('aria-valuenow'));
  await slider.press('PageUp');
  await expect.poll(async () => Number(await slider.getAttribute('aria-valuenow')), { timeout: 30_000 }).toBeGreaterThanOrEqual(before + 30);
  await expectFrames(page);

  await panel.getByRole('button', { name: 'Pause' }).click();
  await expect(panel.getByRole('button', { name: 'Play' })).toBeVisible();
  await panel.getByRole('button', { name: 'Play' }).click();
  await expect(panel.getByRole('button', { name: 'Pause' })).toBeEnabled({ timeout: 30_000 });

  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect.poll(async () => (await streamVideo(page)).width, { timeout: 30_000 }).toBe(0);
});
