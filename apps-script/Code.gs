const DATA_URL = 'https://YOUR-HOST.example/data/cheapest.json';
function syncMacPrices() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Цены') || SpreadsheetApp.getActiveSpreadsheet().insertSheet('Цены');
  const rows = JSON.parse(UrlFetchApp.fetch(DATA_URL).getContentText()).map(x => { const b=x.best; return [b.model,b.chip,b.ramGb,b.storageGb,b.screenIn,b.price,b.retailer,b.url,b.fetchedAt]; });
  sheet.clearContents(); sheet.getRange(1,1,1,9).setValues([['Модель','Чип','RAM, GB','SSD, GB','Экран, дюймы','Минимум, ₽','Магазин','Ссылка','Обновлено']]);
  if (rows.length) sheet.getRange(2,1,rows.length,9).setValues(rows);
}
function createHourlyTrigger() { ScriptApp.newTrigger('syncMacPrices').timeBased().everyHours(1).create(); }
