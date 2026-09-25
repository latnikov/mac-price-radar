"""Read the supplied workbook without modifying it; export its customer price rows."""
import json
import re
import sys
from pathlib import Path
import openpyxl

source = Path(sys.argv[1])
workbook = openpyxl.load_workbook(source, data_only=True)
rows = []
for index, values in enumerate(workbook['Пересчёт'].iter_rows(min_row=5, values_only=True), 5):
    model_chip, specification, apple, weight, delivery, customs, service, total = values
    model, chip, cores = model_chip.split(' · ')
    cpu, gpu = map(int, re.findall(r'\d+', cores))
    memory, storage = specification.split(' / ')
    ram = int(re.search(r'\d+', memory)[0])
    ssd = int(re.search(r'\d+', storage)[0]) * (1024 if 'ТБ' in storage else 1)
    assert all(isinstance(v, (int, float)) for v in [apple, weight, delivery, customs, service, total])
    assert apple + delivery + customs + service == total, index
    rows.append(dict(model=model, chip=chip, cpuCores=cpu, gpuCores=gpu, ramGb=ram,
                     storageGb=ssd, appleUsd=apple, weightKg=weight, deliveryUsd=delivery,
                     customsUsd=customs, serviceUsd=service, totalUsd=total,
                     sourceRow=index))
assert len(rows) == 50
result = dict(source=source.name, sourceSheet='Пересчёт', sourceDate='2026-08-26',
              currency='USD', rows=rows)
Path(sys.argv[2]).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(f'Exported and reconciled {len(rows)} configurations')
