"""python3 -m unittest scripts/test_merge_power_infusion.py (or: npm run test:data)"""
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_power_infusion import blend, carry, combine, merge  # noqa: E402

META = {'schemaVersion': 1, 'engine': {'commit': 'c0ffee'}, 'profiles': 'MID2', 'fightStyle': 'P', 'targetError': 0.1}


def player(dps, timeline, stats):
    return {'name': 'x', 'stats': stats, 'stats_pets': {}, 'buffs': [],
            'collected_data': {'dps': {'mean': dps}, 'timeline_dmg': {'data': timeline}}}


def source(label, base_dps, sd, detail_dps=None):
    spec = {'name': 'Frost Mage', 'profile': 'MID2_Mage_Frost', 'piTiming': 'apl', 'funnel': None, 'runs': [
        {'targets': 1, 'base': {'dps': [base_dps, sd], 'prio': [base_dps, sd]},
         'pi': {'dps': [base_dps + 100, sd], 'prio': [base_dps + 100, sd]}}]}
    d = detail_dps if detail_dps is not None else base_dps
    detail = {'runs': [{'targets': 1, 'base': player(d, [d], [{'name': 'bolt', 'portion_apse': {'mean': d}}]),
                        'pi': player(d + 100, [d + 100], [{'name': 'bolt', 'portion_apse': {'mean': d + 100}}])}]}
    return (label, dict(META, specs=[spec]), {'MID2_Mage_Frost': detail})


class Combine(unittest.TestCase):
    def test_inverse_variance(self):
        self.assertEqual(combine([[100, 3], [104, 3]]), [102, round(3 / math.sqrt(2), 1)])
        # The tighter measurement counts four times as much.
        self.assertEqual(combine([[100, 1], [110, 2]])[0], 102)


class Blend(unittest.TestCase):
    def test_missing_abilities_count_as_zero_and_short_timelines_do_not(self):
        a = {'stats': [{'name': 'bolt', 'dps': 1000, 'school': 'frost'}, {'name': 'proc', 'dps': 200}],
             'timeline': [100, 200, 300]}
        b = {'stats': [{'name': 'bolt', 'dps': 1200, 'school': 'frost'}], 'timeline': [300, 400]}
        self.assertEqual(blend([a, b], [1, 1]), {
            'stats': [{'name': 'bolt', 'dps': 1100, 'school': 'frost'}, {'name': 'proc', 'dps': 100}],
            'timeline': [200, 300, 300]})


class Merge(unittest.TestCase):
    def test_combines_runs_counts_duplicates_once_and_drops_mismatched_detail(self):
        a, b = source('a', 1000, 10), source('b', 1100, 10)
        stale = source('stale', 1200, 10, detail_dps=5000)  # drawer file from a different run
        summary, details, _ = merge([a, b, a, stale])
        spec = summary['specs'][0]
        self.assertEqual((spec['sources'], summary['merged']), (3, True))
        self.assertEqual(spec['runs'][0]['base']['dps'], [1100, round(10 / math.sqrt(3), 1)])
        drawer = details['MID2_Mage_Frost']
        self.assertEqual(drawer['sources'], 2)  # stale detail ignored
        self.assertEqual(drawer['runs'][0]['pi']['collected_data']['dps']['mean'], 1150)
        self.assertEqual(drawer['runs'][0]['base']['stats'][0]['portion_apse']['mean'], 1050)

    def test_refuses_merged_or_mismatched_sources(self):
        a = source('a', 1000, 10)
        merged, _, _ = merge([a])
        with self.assertRaisesRegex(SystemExit, 'already a merge'):
            merge([a, ('m', merged, {})])
        other = ('o', dict(a[1], targetError=0.2), {})
        with self.assertRaisesRegex(SystemExit, 'targetError'):
            merge([a, other])

    def test_carry_keeps_missing_specs_with_their_engine(self):
        old_summary, old_details, _ = merge([source('old', 900, 10)])
        fire = dict(old_summary['specs'][0], name='Fire Mage', profile='MID2_Mage_Fire')
        old = ('old', dict(old_summary, specs=[old_summary['specs'][0], fire]),
               {'MID2_Mage_Frost': old_details['MID2_Mage_Frost'], 'MID2_Mage_Fire': {'runs': 'fire'}})
        new = source('new', 1000, 10)
        new[1]['engine'] = {'commit': 'beef'}
        summary, details, _ = merge([new])
        lines = carry(summary, details, old)
        self.assertEqual([s['name'] for s in summary['specs']], ['Fire Mage', 'Frost Mage'])
        fire_out, frost_out = summary['specs']
        self.assertEqual(fire_out['engine'], {'commit': 'c0ffee'})  # carried keeps its engine
        self.assertNotIn('engine', frost_out)  # fresh spec uses the file's engine
        self.assertEqual(frost_out['runs'][0]['base']['dps'][0], 1000)  # fresh wins over carried
        self.assertEqual(details['MID2_Mage_Fire'], {'runs': 'fire'})
        self.assertEqual((len(lines), summary['carriedFrom']), (1, 'old'))
        with self.assertRaisesRegex(SystemExit, 'targetError'):
            carry(summary, details, ('bad', dict(old[1], targetError=0.2), {}))


if __name__ == '__main__':
    unittest.main()
