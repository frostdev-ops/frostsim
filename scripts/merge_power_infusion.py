#!/usr/bin/env python3
"""Combine independent Power Infusion runs (from several machines) into the data the app bundles.

Each source is one generator output: a power-infusion.json with its pi-detail/ folder beside it,
given as a path or as GIT_REF:PATH (read with `git show`, so data already committed counts too):

  python3 scripts/merge_power_infusion.py \\
      c63be81:src/lib/catalog/generated/power-infusion.json \\
      origin/pi-run/pc1:pi-runs/pc1/power-infusion.json \\
      origin/pi-run/pc2:pi-runs/pc2/power-infusion.json \\
      pi-runs/mac/power-infusion.json

Every run uses a fresh random seed (simc seeds from std::random_device unless seed= is set), so
runs are independent samples and combine by inverse-variance weighting: mean = sum(m/sd^2) /
sum(1/sd^2), sd = 1/sqrt(sum(1/sd^2)). Drawer reports are averaged with the same weights, matched
by ability, pet and buff name; an ability a run never used counts as zero damage in that run.
A spec entry that is byte-identical in two sources (a machine that resumed from committed data)
is counted once. Sources must share engine, profiles, fight style and target error, and a merged
file is refused as a source: always merge from the original runs.

Partial re-sims: after an engine bump that touches only some specs, sim just those, then pass the
previous bundled data (merged or not) with --carry. Specs the new runs lack are copied from it
unchanged, drawer files included, and keep their own engine stamp on the spec entry:

  python3 scripts/merge_power_infusion.py pi-runs/mac/power-infusion.json \
      --carry HEAD:src/lib/catalog/generated/power-infusion.json

Writes src/lib/catalog/generated/power-infusion.json and pi-detail/ (or --out). Standard library
only; Python 3.9+.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import math
import os
import subprocess
from pathlib import Path

from generate_power_infusion import DETAIL, OUT, ROOT, _num

META = ('schemaVersion', 'engine', 'profiles', 'fightStyle', 'targetError')
VARIANTS = ('base', 'pi', 'funnel', 'funnelPi', 'aoe', 'aoePi')


def read(source: str, rel: str | None = None):
    """JSON at a path or GIT_REF:PATH; rel replaces the file name (for pi-detail files)."""
    path = Path(source)
    if path.exists():
        target = path.parent / rel if rel else path
        return json.loads(target.read_text()) if target.exists() else None
    ref, _, inner = source.partition(':')
    if not inner:
        raise SystemExit(f'{source}: no such file (and not GIT_REF:PATH)')
    inner = f'{Path(inner).parent.as_posix()}/{rel}' if rel else inner
    proc = subprocess.run(['git', 'show', f'{ref}:{inner}'], cwd=ROOT, capture_output=True, text=True)
    if proc.returncode != 0:
        if rel:
            return None
        raise SystemExit(f'{source}: {proc.stderr.strip()}')
    return json.loads(proc.stdout)


def combine(pairs: list) -> list:
    """Independent [mean, sd] measurements of one quantity -> one [mean, sd]."""
    if any(sd <= 0 for _, sd in pairs):
        return list(pairs[0]) if len(pairs) == 1 else [_num(sum(m for m, _ in pairs) / len(pairs)), 0]
    w = [1 / sd ** 2 for _, sd in pairs]
    return [_num(sum(wi * m for wi, (m, _) in zip(w, pairs)) / sum(w)), _num(1 / math.sqrt(sum(w)))]


def _round(x: float):
    return _num(x, 0 if abs(x) >= 100 else 2)


def blend(values: list, weights: list):
    """Weighted mean of parallel JSON values. None means the source lacks it: a number counts as 0
    (an ability that never fired dealt no damage), a per-second array just has fewer samples there."""
    present = [v for v in values if v is not None]
    if not present:
        return None
    first = present[0]
    if isinstance(first, (str, bool)):
        return first
    if isinstance(first, (int, float)):
        return _round(sum((v or 0) * w for v, w in zip(values, weights)) / sum(weights))
    if isinstance(first, dict):
        keys = list(dict.fromkeys(k for v in present for k in v))
        return {k: blend([v.get(k) if v is not None else None for v in values], weights) for k in keys}
    if isinstance(first, list):
        if all(isinstance(x, dict) and 'name' in x for v in present for x in v):
            names = list(dict.fromkeys(x['name'] for v in present for x in v))
            by = [{x['name']: x for x in v} if v is not None else {} for v in values]
            return [blend([b.get(n) for b in by], weights) for n in names]
        out = []
        for i in range(max(len(v) for v in present)):
            got = [(v[i], w) for v, w in zip(values, weights) if v is not None and i < len(v)]
            out.append(_round(sum(x * w for x, w in got) / sum(w for _, w in got)))
        return out
    raise ValueError(f'cannot blend {type(first).__name__}')


def matches(spec: dict, detail: dict | None) -> bool:
    """The drawer file belongs to this summary entry (an interrupted run can leave a newer one beside
    an older row). Both carry the run's DPS, rounded to 0.1."""
    if not detail:
        return False
    for run, drun in zip(spec['runs'], detail['runs']):
        for v in VARIANTS:
            if v in run and abs(drun[v]['collected_data']['dps']['mean'] - run[v]['dps'][0]) > 1:
                return False
    return len(spec['runs']) == len(detail['runs'])


def fingerprint(spec: dict) -> str:
    return hashlib.sha256(json.dumps(spec['runs'], sort_keys=True).encode()).hexdigest()


def merge(sources: list) -> tuple[dict, dict, list]:
    """sources: [(label, summary, {profile: detail or None})] -> (summary, {profile: detail}, report lines)."""
    meta = {k: sources[0][1][k] for k in META}
    for label, summary, _ in sources:
        if summary.get('merged'):
            raise SystemExit(f'{label} is already a merge; pass the original runs instead')
        diff = [k for k in META if summary.get(k) != meta[k]]
        if diff:
            raise SystemExit(f'{label} differs from {sources[0][0]} in {", ".join(diff)}; not combinable')

    # spec name -> [(label, spec entry, detail or None)], identical entries counted once
    specs: dict = {}
    seen: set = set()
    for label, summary, details in sources:
        for spec in summary['specs']:
            fp = fingerprint(spec)
            if fp in seen:
                continue
            seen.add(fp)
            detail = details.get(spec['profile'])
            specs.setdefault(spec['name'], []).append((label, spec, detail if matches(spec, detail) else None))

    out_specs, out_details, report = [], {}, []
    for name in sorted(specs):
        entries = specs[name]
        head = entries[0][1]
        for label, spec, _ in entries[1:]:
            for k in ('profile', 'piTiming', 'funnel'):
                if spec[k] != head[k]:
                    raise SystemExit(f'{name}: {k} is {spec[k]!r} in {label} but {head[k]!r} in {entries[0][0]}')
        runs, detail_runs = [], []
        with_detail = [e for e in entries if e[2]]
        for i, n in enumerate(r['targets'] for r in head['runs']):
            run, drun = {'targets': n}, {'targets': n}
            for v in VARIANTS:
                got = [e[1]['runs'][i][v] for e in entries if v in e[1]['runs'][i]]
                if not got:
                    continue
                run[v] = {m: combine([g[m] for g in got]) for m in ('dps', 'prio')}
                reports = [(e[2]['runs'][i][v], e[1]['runs'][i][v]['dps'][1]) for e in with_detail
                           if v in e[1]['runs'][i] and v in e[2]['runs'][i]]
                if reports:
                    drun[v] = blend([p for p, _ in reports], [1 / sd ** 2 if sd > 0 else 1 for _, sd in reports])
            runs.append(run)
            detail_runs.append(drun)
        # A run from before AoE builds existed lacks 'aoe'; it still counts for base and pi.
        out_specs.append(dict({k: head[k] for k in ('name', 'profile', 'piTiming', 'funnel')},
                              aoe=any(e[1].get('aoe') for e in entries), runs=runs, sources=len(entries)))
        if with_detail:
            out_details[head['profile']] = dict(meta, profile=head['profile'], runs=detail_runs,
                                                sources=len(with_detail))
        report.append(f'{name:<30} {len(entries)} runs, {len(with_detail)} with drawer data  '
                      f'({", ".join(label for label, _, _ in entries)})')
    summary = dict(meta, generatedAt=datetime.date.today().isoformat(), merged=True,
                   sourceLabels=[label for label, _, _ in sources], specs=out_specs)
    return summary, out_details, report


def carry(summary: dict, details: dict, prev: tuple) -> list:
    """Copy the specs the new runs lack from prev = (label, summary, {profile: detail}), in place.
    A carried spec keeps the engine it was simmed on; everything else in META must match."""
    label, old, old_details = prev
    diff = [k for k in META if k != 'engine' and old.get(k) != summary[k]]
    if diff:
        raise SystemExit(f'{label} differs in {", ".join(diff)}; cannot carry its specs')
    have = {s['name'] for s in summary['specs']}
    moved = [s for s in old['specs'] if s['name'] not in have]
    for spec in moved:
        summary['specs'].append(dict(spec, engine=spec.get('engine') or old['engine']))
        if old_details.get(spec['profile']):
            details[spec['profile']] = old_details[spec['profile']]
    summary['specs'].sort(key=lambda s: s['name'])
    if moved:
        summary['carriedFrom'] = label
    return [f'{s["name"]:<30} carried from {label} ({(s.get("engine") or old["engine"])["commit"][:10]})'
            for s in moved]


def load(source: str) -> tuple:
    summary = read(source)
    return (source, summary,
            {s['profile']: read(source, f"{DETAIL}/{DETAIL}-{s['profile']}.json") for s in summary['specs']})


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sources', nargs='+', help='power-infusion.json paths or GIT_REF:PATH')
    ap.add_argument('--out', type=Path, default=OUT, help='merged output (default: the file the app bundles)')
    ap.add_argument('--carry', help='previous data (path or GIT_REF:PATH); specs the sources lack are kept from it')
    ap.add_argument('--dry-run', action='store_true', help='print what would be combined, write nothing')
    opts = ap.parse_args()

    summary, details, report = merge([load(s) for s in opts.sources])  # everything is read before anything is written
    if opts.carry:
        report += carry(summary, details, load(opts.carry))
    print('\n'.join(report))
    if opts.dry_run:
        return

    out = opts.out.resolve()
    detail_dir = out.parent / DETAIL
    detail_dir.mkdir(parents=True, exist_ok=True)
    for profile, data in details.items():
        path = detail_dir / f'{DETAIL}-{profile}.json'
        tmp = path.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(data, separators=(',', ':')) + '\n')
        os.replace(tmp, path)
    tmp = out.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(summary, indent=1) + '\n')
    os.replace(tmp, out)
    print(f'wrote {out} ({len(summary["specs"])} specs) and {len(details)} drawer files')


if __name__ == '__main__':
    main()
