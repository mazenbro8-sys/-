import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  formatRelativeNotifTime,
  sortAndPrepareNotifications,
  enqueueToastItem,
} from '../public/shared.js';

const NOW = 1_760_000_000_000;

test('formatRelativeNotifTime formats concise Arabic durations with English digits', () => {
  assert.equal(formatRelativeNotifTime(null, NOW), '—');
  assert.equal(formatRelativeNotifTime(NOW - 15_000, NOW), 'الآن');
  assert.equal(formatRelativeNotifTime(NOW - 5 * 60_000, NOW), 'قبل 5 د');
  assert.equal(formatRelativeNotifTime(NOW - 3 * 3_600_000, NOW), 'قبل 3 س');
  assert.equal(formatRelativeNotifTime(NOW - 2 * 86_400_000, NOW), 'قبل 2 ي');
  assert.doesNotMatch(formatRelativeNotifTime(NOW - 5 * 60_000, NOW), /[٠-٩۰-۹]/);
});

test('sortAndPrepareNotifications pins unread requires_ack first and groups > 5 unread', () => {
  const rows = [
    { id: 1, title: 'عادي قديم', created_at: NOW - 600_000, requires_ack: 0, read: false },
    { id: 2, title: 'عادي أحدث', created_at: NOW - 100_000, requires_ack: 0, read: false },
    { id: 3, title: 'إلغاء مهم', created_at: NOW - 500_000, requires_ack: 1, read: false },
    { id: 4, title: 'إلغاء مؤكد مسبقاً', created_at: NOW - 50_000, requires_ack: 1, read: true, read_at: NOW - 40_000 },
    { id: 5, title: 'رسالة 3', created_at: NOW - 200_000, requires_ack: 0, read: false },
    { id: 6, title: 'رسالة 4', created_at: NOW - 300_000, requires_ack: 0, read: false },
    { id: 7, title: 'رسالة 5', created_at: NOW - 400_000, requires_ack: 0, read: false },
    { id: 8, title: 'إلغاء أحدث', created_at: NOW - 250_000, requires_ack: 1, read: false },
  ];

  const prepared = sortAndPrepareNotifications(rows, { groupThreshold: 5 });

  // Unread requires_ack pinned first (newest pinned ack id=8 before older id=3)
  assert.deepEqual(prepared.pinnedAckItems.map((x) => x.id), [8, 3]);
  assert.equal(prepared.items[0].id, 8);
  assert.equal(prepared.items[1].id, 3);
  // Already-read requires_ack (id=4) moves with regular newest-first timeline right after pinned acks
  assert.equal(prepared.items[2].id, 4);
  assert.equal(prepared.items[3].id, 2);

  // 7 unread total (> 5) -> grouped banner enabled
  assert.equal(prepared.unreadCount, 7);
  assert.equal(prepared.shouldGroupBanner, true);
  assert.equal(prepared.bannerText, 'لديك 7 رسائل جديدة');

  // regularUnreadIds excludes un-acked requires_ack (8, 3) and already-read (4)
  assert.deepEqual(prepared.regularUnreadIds.sort((a, b) => a - b), [1, 2, 5, 6, 7]);

  // <= 5 unread -> grouped banner off
  const small = sortAndPrepareNotifications(rows.slice(0, 5), { groupThreshold: 5 });
  assert.equal(small.shouldGroupBanner, false);
  assert.equal(small.bannerText, '');
});

test('enqueueToastItem deduplicates, caps queue, prioritizes high items, and collapses tagged bursts', () => {
  let q = [];
  for (let i = 1; i <= 15; i++) {
    q = enqueueToastItem(q, { msg: `رسالة ${i}`, tag: 'other' }, { maxQueue: 6 });
  }
  assert.equal(q.length, 6);
  assert.equal(q[0].msg, 'رسالة 10');

  q = enqueueToastItem(q, { msg: 'رسالة 15', tag: 'other' }, { maxQueue: 6 });
  assert.equal(q.length, 6, 'duplicate toast message must be ignored');

  q = enqueueToastItem(q, { msg: 'أولوية قصوى', priority: 'high' }, { maxQueue: 6 });
  assert.equal(q[0].msg, 'أولوية قصوى');

  // Collapse ws-notif burst tag cleanly into single grouped notice
  q = enqueueToastItem(q, { msg: '🔔 تنبيه 1', tag: 'ws-notif', replaceTag: true }, { maxQueue: 12 });
  q = enqueueToastItem(q, { msg: '🔔 تنبيه 2', tag: 'ws-notif', replaceTag: true }, { maxQueue: 12 });
  q = enqueueToastItem(q, { msg: '📩 لديك 15 رسائل جديدة', tag: 'ws-notif', replaceTag: true }, { maxQueue: 12 });
  assert.equal(q.filter((x) => x.tag === 'ws-notif').length, 1);
  assert.equal(q.find((x) => x.tag === 'ws-notif').msg, '📩 لديك 15 رسائل جديدة');
});

test('CaptainService.java groups admin messages under one Android notification group with single burst chime', () => {
  const javaSvc = fs.readFileSync(
    new URL('../android-captain/app/src/main/java/sy/panther/captain/CaptainService.java', import.meta.url),
    'utf8'
  );

  assert.match(javaSvc, /GROUP_KEY_ADMIN_MSGS\s*=\s*"sy\.panther\.captain\.ADMIN_MESSAGES"/);
  assert.match(javaSvc, /\.setGroup\(GROUP_KEY_ADMIN_MSGS\)/);
  assert.match(javaSvc, /\.setGroupSummary\(true\)/);
  assert.match(javaSvc, /\.setOnlyAlertOnce\(true\)/);
  assert.match(javaSvc, /setGroupAlertBehavior\(Notification\.GROUP_ALERT_SUMMARY\)/);
  assert.match(javaSvc, /NOTIF_MSG_BASE_ID\s*\+\s*\(msgId\s*%\s*10_000\)/);
  assert.match(javaSvc, /new Notification\.InboxStyle\(\)/);
  assert.match(javaSvc, /"لديك "\s*\+\s*totalUnread\s*\+\s*" رسائل جديدة"/);
  assert.match(javaSvc, /التتبع شغّال أثناء ساعات العمل/);

  // Ensure vibrateBrief is NEVER called outside the canChime cooldown gate inside checkUnreadMessages
  const checkMsgsMatch = javaSvc.match(/private void checkUnreadMessages\([\s\S]*?private LinkedHashSet<Integer> loadAlertedNotifIds/);
  assert.ok(checkMsgsMatch, 'checkUnreadMessages method must exist');
  const vibrateCalls = checkMsgsMatch[0].match(/vibrateBrief\s*\(/g) || [];
  assert.equal(vibrateCalls.length, 1, 'checkUnreadMessages must vibrate at most once per canChime burst');
});

test('Public assets and CSS use non-overlapping top toast, 48px targets, bottom-sheet inbox, and consistent v36 JS cache busting', () => {
  const appCss = fs.readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(appCss, /#toast\.toast-region\s*\{[\s\S]*?inset-block-start:/);
  assert.doesNotMatch(appCss, /body:has\(\.bottom-nav\)\s+#toast\s*\{/);
  assert.match(appCss, /@media\s*\(max-width:\s*767px\)\s*\{[\s\S]*?dialog\.notif-inbox-dialog/);
  assert.match(appCss, /\.notif-expand-btn[\s\S]*?min-height:\s*var\(--touch-min\)/);
  assert.match(appCss, /button\.toast-close[\s\S]*?min-block-size:\s*var\(--touch-min\)/);

  for (const file of ['captain.html', 'admin.html', 'merchant.html', 'index.html']) {
    const html = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(html, /app\.css\?v=panther2026v34/, `${file} must load app.css?v=panther2026v34`);
  }
  for (const file of ['captain.js', 'admin.js', 'merchant.js', 'download.js']) {
    const js = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.match(js, /shared\.js\?v=panther2026v36/, `${file} must import shared.js?v=panther2026v36`);
  }
  assert.ok(fs.readFileSync(new URL('../public/captain.html', import.meta.url), 'utf8').includes('captain.js?v=panther2026v36'));
  assert.ok(fs.readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8').includes('/admin.js?v=panther2026v36'));
  assert.ok(fs.readFileSync(new URL('../public/merchant.html', import.meta.url), 'utf8').includes('/merchant.js?v=panther2026v36'));
  assert.ok(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8').includes('/download.js?v=panther2026v36'));
});
