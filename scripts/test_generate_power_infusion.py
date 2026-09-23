"""python3 -m unittest scripts/test_generate_power_infusion.py (or: npm run test:data)"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import threading  # noqa: E402

from generate_power_infusion import (  # noqa: E402
    PI_POOL, PI_TIMED, Glyphs, Runner, System, Task, bar, check_engine, extract_variant, paint, pick_profiles, run_args,
    trim_stat, variants)

PROFILES = Path(__file__).resolve().parent.parent / 'vendor/simc/profiles/MID2'
OPTS = dict(target_error=0.1, threads=16, profile_path='p.simc', json_path='o.json')
TAIL = ['fight_style=CastingPatchwerk', 'desired_targets=5', 'target_error=0.1', 'threads=16',
        'json=o.json,version=2']
MM = {'name': 'Marksmanship Hunter', 'profile': 'x', 'piTiming': 'apl', 'funnel': 'max_prio_damage'}


def dist(mean, sd):
    return {'mean': mean, 'mean_std_dev': sd}


def player(cd, **extra):
    tl = {'mean': 10.04, 'min': 0, 'max': 30.6, 'data': [0.4, 10.6, 30.2]}
    return dict({'name': 'MID2_Hunter_Marksmanship', 'stats': [], 'buffs': [],
                 'collected_data': dict(cd, timeline_dmg=tl)}, **extra)


class PickProfiles(unittest.TestCase):
    @unittest.skipUnless(PROFILES.is_dir(), 'MISSING ARTIFACT vendor/simc (npm run engine:bootstrap)')
    def test_one_base_profile_per_spec_with_pi_and_funnel_detection(self):
        specs = pick_profiles([(p.name, p.read_text()) for p in PROFILES.glob('*.simc')])
        by = {s['name']: s for s in specs}
        self.assertEqual(len(by), len(specs))
        self.assertEqual(by['Unholy Death Knight']['profile'], 'MID2_Death_Knight_Unholy')
        self.assertEqual((by['Beast Mastery Hunter']['piTiming'], by['Beast Mastery Hunter']['funnel']),
                         ('apl', 'max_prio_damage'))
        self.assertEqual(by['Subtlety Rogue']['funnel'], 'priority_rotation')
        self.assertIsNone(by['Frost Mage']['funnel'])
        self.assertEqual([s['name'] for s in specs if s['piTiming'] == 'cooldown'], [
            'Blood Death Knight', 'Brewmaster Monk', 'Havoc Demon Hunter', 'Outlaw Rogue',
            'Protection Paladin', 'Protection Warrior'])


class RunArgs(unittest.TestCase):
    def test_one_full_run_per_variant(self):
        self.assertEqual(variants(MM, 1), ['base', 'pi'])
        self.assertEqual(variants(MM, 5), ['base', 'pi', 'funnel', 'funnelPi'])
        self.assertEqual(run_args(MM, 5, 'base', **OPTS), ['p.simc', 'max_prio_damage=0', *TAIL])
        self.assertEqual(run_args(MM, 5, 'funnelPi', **OPTS), ['p.simc', 'max_prio_damage=1', PI_POOL, *TAIL])
        outlaw = {'name': 'Outlaw Rogue', 'profile': 'x', 'piTiming': 'cooldown', 'funnel': None}
        self.assertEqual(variants(outlaw, 5), ['base', 'pi'])
        self.assertEqual(run_args(outlaw, 5, 'pi', **OPTS), ['p.simc', PI_TIMED, *TAIL])


class ExtractVariant(unittest.TestCase):
    def test_reads_dps_and_priority_dps_and_trims_the_player(self):
        pi = {'name': 'power_infusion', 'spell': 10060, 'start_count': 2.83, 'uptime': 14.18,
              'default_value': 0.2, 'stack_uptime': {'mean': 0.15, 'data': [0, 0.851, 1.0]}}
        pets = {'spotting_eagle': [{'name': 'x', 'type': 'heal'}]}
        run, p = extract_variant({'sim': {'players': [player(
            {'dps': dist(439935.04, 442.1), 'prioritydps': dist(183523, 300)},
            buffs=[pi, {'name': 'trueshot'}], stats_pets=pets)]}})
        self.assertEqual(run, {'dps': [439935, 442.1], 'prio': [183523, 300]})
        self.assertEqual(p['buffs'], [{'name': 'power_infusion', 'spell': 10060, 'start_count': 2.83,
                                       'uptime': 14.18, 'stack_uptime': {'data': [0, 0.85, 1]}}])
        self.assertEqual(p['collected_data'], {'dps': {'mean': 439935},
                                               'timeline_dmg': {'mean': 10, 'min': 0, 'max': 30.6, 'data': [0, 11, 30]}})
        self.assertEqual(p['stats_pets'], {})  # a pet with no damage adds nothing to the breakdown

    def test_one_target_uses_dps_as_priority_and_fails_closed(self):
        run, _ = extract_variant({'sim': {'players': [player({'dps': dist(100, 1)})]}})
        self.assertEqual(run['prio'], [100, 1])
        with self.assertRaisesRegex(ValueError, 'expected one player'):
            extract_variant({'sim': {'players': []}})


class CheckEngine(unittest.TestCase):
    def test_only_the_locked_engine_passes(self):
        lock = 'c01572044af513f9d85b79080b8d14619f1c00c5'
        check_engine({'git_revision': 'c015720', 'version': '1210-01'}, lock, '1210-01')
        for report in ({'git_revision': 'abcdef1', 'version': '1210-01'}, {'version': '1210-01'},
                       {'git_revision': 'c015720', 'version': '1205-02'}, {'git_revision': 'c0', 'version': '1210-01'}):
            with self.assertRaisesRegex(RuntimeError, 'lock says 1210-01 at c01572044a'):
                check_engine(report, lock, '1210-01')


class TrimStat(unittest.TestCase):
    def test_keeps_what_detail_ts_reads_and_damage_under_non_damage_parents(self):
        dmg = {'name': 'aimed_shot', 'spell_name': 'Aimed Shot', 'id': 19434, 'type': 'damage',
               'portion_apse': dist(1234.56, 1), 'actual_amount': dist(9.7, 1), 'compound_amount': 99.6,
               'num_executes': dist(3.456, 0), 'total_intervals': dist(1, 1), 'resource_gain': {},
               'direct_results': {'crit': {'count': {'sum': 4.2}, 'pct': 1}, 'hit': {'pct': 1}}}
        self.assertEqual(trim_stat(dmg), {
            'name': 'aimed_shot', 'spell_name': 'Aimed Shot', 'id': 19434, 'type': 'damage',
            'portion_apse': {'mean': 1234.6}, 'actual_amount': {'mean': 10}, 'num_executes': {'mean': 3.46},
            'compound_amount': 100, 'direct_results': {'crit': {'count': {'sum': 4}}}})
        self.assertIsNone(trim_stat({'name': 'focus', 'type': 'resource', 'children': [{'name': 'h', 'type': 'heal'}]}))
        parent = trim_stat({'name': 'p', 'type': 'heal', 'children': [dmg]})
        self.assertEqual((parent['type'], parent['children'][0]['name']), ('heal', 'aimed_shot'))


class RunnerTest(unittest.TestCase):
    def tasks(self):
        a, b = {'name': 'A'}, {'name': 'B'}
        return [Task(a, 1, 'base'), Task(a, 1, 'pi'), Task(b, 1, 'base'), Task(b, 1, 'pi')]

    def test_every_sim_runs_and_each_spec_is_handed_over_once_complete(self):
        specs, lock = [], threading.Lock()

        def on_spec(spec, results):
            with lock:
                specs.append((spec['name'], sorted(results)))
        r = Runner(self.tasks(), lambda t, jobs: f"{t.spec['name']}{t.variant}", on_spec, jobs=2, max_jobs=4).start()
        for w in r.workers:
            w.join(5)
        self.assertEqual(sorted(specs), [('A', [(1, 'base'), (1, 'pi')]), ('B', [(1, 'base'), (1, 'pi')])])
        self.assertEqual((len(r.done), r.errors, len(r.pending)), (4, [], 0))
        self.assertIsNotNone(r.eta())

    def test_a_failed_sim_stops_new_ones_and_is_reported(self):
        def run_one(t, jobs):
            if t.variant == 'pi':
                raise RuntimeError('engine exit 1')
            return 1
        r = Runner(self.tasks(), run_one, lambda *a: None, jobs=1, max_jobs=2).start()
        for w in r.workers:
            w.join(5)
        self.assertEqual([(t.variant, m) for t, m in r.errors], [('pi', 'engine exit 1')])
        self.assertEqual((len(r.done), len(r.pending)), (1, 2))

    def test_pause_holds_and_jobs_clamp(self):
        gate = threading.Event()
        r = Runner(self.tasks(), lambda t, jobs: gate.wait(5), lambda *a: None, jobs=9, max_jobs=2)
        self.assertEqual(r.jobs, 2)
        r.set_jobs(0)
        self.assertEqual(r.jobs, 1)
        r.pause()
        r.start()
        time_left = [w.is_alive() for w in r.workers]
        self.assertEqual((time_left, len(r.pending)), ([True, True], 4))
        r.pause()
        gate.set()
        for w in r.workers:
            w.join(5)
        self.assertEqual(len(r.done), 4)


class Drawing(unittest.TestCase):
    def test_bar_fills_to_width_in_eighths_and_paint_cuts_to_width(self):
        g = Glyphs(True)
        self.assertEqual(bar(0.5, 4, g), ('██', '██'))
        self.assertEqual(bar(3 / 16, 2, g), ('▍', '█'))
        self.assertEqual(''.join(bar(2, 3, g)), '███')
        self.assertEqual(paint([('abc', ''), ('def', '')], 4), 'abcd')

    def test_system_reads_this_machine(self):
        sysinfo = System()
        sysinfo.sample()
        sysinfo.sample()
        used, total = sysinfo.mem
        self.assertTrue(0 < used < total)


if __name__ == '__main__':
    unittest.main()
