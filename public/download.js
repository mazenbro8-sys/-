import { toast } from './shared.js?v=panther2026v20';

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const url = location.origin + btn.dataset.copy;
  try {
    await navigator.clipboard.writeText(url);
    toast('✅ تم نسخ رابط تحميل التطبيق لمشاركته');
  } catch {
    prompt('انسخ رابط تحميل التطبيق:', url);
  }
});
