"""
Step 1 of the offline barcode database: pull the columns we map out of the
Open Food Facts Parquet export and write one JSON line per usable product.

    curl -L -o tools/data/off-food.parquet \
      https://huggingface.co/datasets/openfoodfacts/product-database/resolve/main/food.parquet
    python tools/extract-off.py            # -> tools/data/off-candidates.jsonl
    node tools/build-barcode-db.mjs        # -> app/public/data/barcodes.bin.gz

Python only because pyarrow can stream a 7.8 GB file one row group at a time.
No mapping or validation happens here: every line is shaped like an Open Food
Facts API `product` so tools/build-barcode-db.mjs can run the same
`fromOffProduct` the app used to run on live lookups.

Data is (c) Open Food Facts contributors, ODbL 1.0.
"""
import json
import math
import sys
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent
SRC = ROOT / 'data' / 'off-food.parquet'
OUT = ROOT / 'data' / 'off-candidates.jsonl'

COLUMNS = [
    'code', 'product_name', 'lang', 'brands', 'serving_size', 'nutrition_data_per',
    'nutriments', 'unique_scans_n', 'popularity_key', 'countries_tags', 'obsolete',
]

# Keys read by packages/off-food FIELDS, plus the energy and salt fallbacks.
NUTRIMENTS = {
    'energy-kcal', 'energy-kj', 'energy', 'salt', 'proteins', 'fat', 'carbohydrates',
    'fiber', 'sugars', 'saturated-fat', 'sodium',
}


def finite(v):
    return v is not None and math.isfinite(v)


def pick_name(names, lang):
    if not names:
        return ''
    by_lang = {n['lang']: (n['text'] or '').strip() for n in names}
    return by_lang.get(lang) or by_lang.get('main') or next((v for v in by_lang.values() if v), '')


def main():
    pf = pq.ParquetFile(SRC)
    kept = seen = 0
    with OUT.open('w', encoding='utf-8', newline='\n') as out:
        for i in range(pf.metadata.num_row_groups):
            for r in pf.read_row_group(i, columns=COLUMNS).to_pylist():
                seen += 1
                code = (r['code'] or '').strip()
                if r['obsolete'] or not code.isdigit() or len(code) not in (8, 12, 13):
                    continue
                nutriments = {}
                for n in r['nutriments'] or []:
                    if n['name'] not in NUTRIMENTS:
                        continue
                    if finite(n['100g']):
                        nutriments[f"{n['name']}_100g"] = n['100g']
                    if finite(n['value']):
                        nutriments[n['name']] = n['value']
                if not any(k.startswith('energy') for k in nutriments):
                    continue
                name = pick_name(r['product_name'], r['lang'])
                if not name:
                    continue
                out.write(json.dumps({
                    'code': code,
                    'product_name': name,
                    'brands': r['brands'],
                    'serving_size': r['serving_size'],
                    'nutrition_data_per': r['nutrition_data_per'],
                    'nutriments': nutriments,
                    'scans': r['unique_scans_n'] or 0,
                    'popularity': r['popularity_key'] or 0,
                    'countries': [c.removeprefix('en:') for c in (r['countries_tags'] or [])],
                }, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n')
                kept += 1
            if i % 200 == 0:
                print(f'row group {i}/{pf.metadata.num_row_groups}: {kept}/{seen} kept', file=sys.stderr)
    print(f'{kept} candidates of {seen} products -> {OUT}')


if __name__ == '__main__':
    main()
