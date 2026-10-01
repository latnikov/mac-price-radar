import { readFileSync } from 'node:fs';
import { esc, when } from './views.mjs';

export function systemView(env, store) {
  let health;
  try { health = JSON.parse(readFileSync(env.STORE_HEALTH_FILE, 'utf8')); } catch { /* Explicitly display missing monitor state. */ }
  const sync = store.setting('price_sync'), worker = store.setting('worker_heartbeat');
  const backup = health?.backup;
  const labels = { disk: 'Диск заполнен более чем на 80%', memory: 'Мало свободной памяти', service: 'Служба не отвечает',
    worker_stale: 'Нет сигнала от фонового процесса', price_sync_stale: 'Цены давно не обновлялись',
    integration: 'Проверьте подключение внешнего источника', legacy_orders_import: 'Не удалось перенести прежние заказы', backup_stale: 'Резервная копия старше 26 часов' };
  return `<h2>Состояние платформы</h2>${health?`<p>Проверено: ${when(health.at * 1000)}</p><div class="row"><div class="box">Диск: ${esc(health.disk_percent)}%<br>Свободно: ${(health.disk_free / 1024**3).toFixed(1)} ГБ</div><div class="box">Доступная память: ${esc(health.memory_available_mb)} МБ</div></div>${health.alerts.length?health.alerts.map(a=>`<p class="notice error">${esc(labels[a.kind] || a.kind)}${a.channel?`: ${esc(a.channel)} ${esc(a.account)}`:''}${a.name?`: ${esc(a.name)}`:''}</p>`).join(''):'<p class="notice">Проверки пройдены.</p>'}`:'<p class="notice error">Нет свежего отчёта мониторинга. Проверьте серверную службу.</p>'}<p>Фоновый процесс: ${when(worker?.at)}.<br>Обновление каталога: ${when(sync?.at)}.</p><p>Проверенная резервная копия: ${backup?.verified?when(backup.at * 1000):'ещё не подтверждена'}. ${backup?.bytes?`Размер: ${(backup.bytes / 1024**2).toFixed(0)} МБ.`:''}</p><p>Мониторинг, синхронизация, резервирование и очистка временных записей выполняются сервером самостоятельно.</p>`;
}
