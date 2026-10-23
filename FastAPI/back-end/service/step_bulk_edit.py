"""Mass edit of testcase steps (find-and-replace over steps).

Pure functions over step dicts - the router (routers/TestCases.bulk_edit_steps)
uses the exact same code for the dry-run preview and the real apply, so what
the preview shows is what gets saved.

A request is: which steps (filter) + what to change (ops, applied in order).

filter:
  action        - only steps with this action
  pi            - only steps aimed at this Pi (target == pi, or pi in
                  target_pi_ids for multicast)
  param_name /
  param_value   - only steps whose params[param_name] == param_value
                  (compared as text, so 5 matches "5")

ops (each a dict with "op"):
  set_param        name, value         params[name] = value (added if missing)
  replace_param    name, from, to      only where params[name] == from
  remove_param     name
  replace_target   from, to            Pi id in target / target_pi_ids, the
                                       Pi's key in per-Pi interface maps
                                       (merged if `to` already has one), and
                                       pi:<from>/... client references
  rename_interface from, to            inside params.interface / .interfaces
                                       (list, string, or {pi: [...]} map)
  set_interfaces   pi, interfaces      overwrite which interfaces of `pi` the
                                       step uses. A step already aimed at
                                       `pi` alone gets its flat interface
                                       list replaced; a multicast/{pi: [...]}
                                       map gets just that Pi's entry changed
                                       (other Pis untouched) and `pi` is
                                       added to target_pi_ids if it wasn't
                                       there yet. A step aimed at a single
                                       *different* Pi is retargeted to `pi`
                                       (this is the only way to point such a
                                       step at another Pi's radios). A step
                                       with no interface param, or a
                                       broadcast ("all") step's shared flat
                                       list, is left alone.
  set_field        name, value         delay_before_seconds | repeat_count
  set_expected     field, cmp, value   add or replace that field's check
  remove_expected  field
"""
import copy
import json

STEP_FIELDS = {"delay_before_seconds": float, "repeat_count": int}
EXPECT_OPS = ("==", "!=", ">", ">=", "<", "<=", "contains", "exists")


class BulkEditError(ValueError):
    pass


def _text(v):
    return v if isinstance(v, str) else json.dumps(v)


def _short(v):
    s = _text(v)
    return s if len(s) <= 60 else s[:57] + "..."


def step_matches(step: dict, flt: dict) -> bool:
    if flt.get("action") and step.get("action") != flt["action"]:
        return False
    pi = flt.get("pi")
    if pi and step.get("target") != pi and pi not in (step.get("target_pi_ids") or []):
        return False
    name = flt.get("param_name")
    if name:
        params = step.get("params") or {}
        if name not in params:
            return False
        want = flt.get("param_value")
        if want not in (None, "") and _text(params[name]) != _text(want):
            return False
    return True


def _rename_in_iface_value(value, old, new):
    if isinstance(value, str):
        return new if value == old else value
    if isinstance(value, list):
        return [new if v == old else v for v in value]
    if isinstance(value, dict):
        return {k: _rename_in_iface_value(v, old, new) for k, v in value.items()}
    return value


def _expected_list(step):
    e = step.get("expected")
    if not e:
        return []
    return [e] if isinstance(e, dict) else [x for x in e if x]


def apply_ops(step: dict, ops: list) -> tuple[dict, list[str]]:
    """(edited copy of step, human-readable diff lines). Empty diff = no-op."""
    s = copy.deepcopy(step)
    s.setdefault("params", {})
    diffs = []
    for o in ops:
        kind = o.get("op")
        p = s["params"]
        if kind == "set_param":
            name, val = o["name"], o.get("value")
            if p.get(name) != val:
                diffs.append(f"{name}: {_short(p[name]) if name in p else '(unset)'} → {_short(val)}")
                p[name] = val
        elif kind == "replace_param":
            name = o["name"]
            if name in p and _text(p[name]) == _text(o.get("from")):
                diffs.append(f"{name}: {_short(p[name])} → {_short(o.get('to'))}")
                p[name] = o.get("to")
        elif kind == "remove_param":
            if o["name"] in p:
                diffs.append(f"{o['name']}: {_short(p[o['name']])} → (removed)")
                del p[o["name"]]
        elif kind == "replace_target":
            old, new = o["from"], o["to"]
            if s.get("target") == old:
                s["target"] = new
                diffs.append(f"target: {old} → {new}")
            ids = s.get("target_pi_ids") or []
            if old in ids:
                s["target_pi_ids"] = list(dict.fromkeys(new if i == old else i for i in ids))
                diffs.append(f"target_pi_ids: {old} → {new}")
            for key in ("interface", "interfaces"):
                v = p.get(key)
                if isinstance(v, dict) and old in v:
                    moved = {k: val for k, val in v.items() if k != old}
                    # merge, don't overwrite, if the new Pi already had a selection
                    moved[new] = list(dict.fromkeys([*moved.get(new, []), *v[old]]))
                    p[key] = moved
                    diffs.append(f"{key}: {old}'s selection → {new}")
            # pi:<pi>/<iface> client references (e.g. ping target)
            for key, v in list(p.items()):
                if isinstance(v, str) and v.startswith(f"pi:{old}/"):
                    p[key] = f"pi:{new}/" + v[len(f"pi:{old}/"):]
                    diffs.append(f"{key}: {v} → {p[key]}")
        elif kind == "rename_interface":
            old, new = o["from"], o["to"]
            for key in ("interface", "interfaces"):
                if key in p:
                    renamed = _rename_in_iface_value(p[key], old, new)
                    if renamed != p[key]:
                        diffs.append(f"{key}: {old} → {new}")
                        p[key] = renamed
        elif kind == "set_interfaces":
            pi = o.get("pi")
            new = [str(i) for i in (o.get("interfaces") or []) if str(i).strip()]
            if not pi:
                raise BulkEditError("set_interfaces: pi is required")
            if not new:
                raise BulkEditError("set_interfaces: pick at least one interface")
            iface_keys = [key for key in ("interface", "interfaces") if key in p]
            if not iface_keys:
                continue  # this action has no interface selection to set
            # A missing target means "all" (step_matches/the UI both treat it
            # that way), never a single Pi to retarget.
            target = s.get("target") or "all"
            ids = s.get("target_pi_ids") or []

            if target == "multicast":
                # Point this multi-Pi step at `pi` too if it wasn't already -
                # otherwise its own interface entry would belong to a Pi the
                # step never runs on.
                if pi not in ids:
                    s["target_pi_ids"] = [*ids, pi]
                    diffs.append(f"target_pi_ids: + {pi}")
                for key in iface_keys:
                    v = p[key]
                    if isinstance(v, dict) and v.get(pi) != new:
                        diffs.append(f"{key} on {pi}: {_short(v.get(pi, '(none)'))} → {_short(new)}")
                        p[key] = {**v, pi: new}
                    # a flat (non-map) selection here is shared by every Pi
                    # the step targets - leave it alone rather than force it
                    # on everyone just because one Pi changed.
            elif target == "all":
                for key in iface_keys:
                    v = p[key]
                    if isinstance(v, dict) and v.get(pi) != new:
                        diffs.append(f"{key} on {pi}: {_short(v.get(pi, '(none)'))} → {_short(new)}")
                        p[key] = {**v, pi: new}
                    # same reasoning as multicast above for a flat selection.
            else:
                # Single-Pi step: not just this Pi's own interfaces - the
                # only way a step like this can use a *different* Pi's radios
                # is to be pointed at that Pi, so do that too.
                if target != pi:
                    diffs.append(f"target: {target or '(none)'} → {pi}")
                    s["target"] = pi
                for key in iface_keys:
                    v = p[key]
                    # Keep a single-name string a string, as older steps saved it.
                    val = new[0] if isinstance(v, str) and len(new) == 1 else new
                    if v != val:
                        diffs.append(f"{key}: {_short(v)} → {_short(val)}")
                        p[key] = val
        elif kind == "set_field":
            name = o["name"]
            if name not in STEP_FIELDS:
                raise BulkEditError(f"set_field: name must be one of {list(STEP_FIELDS)}")
            try:
                val = STEP_FIELDS[name](o.get("value"))
            except (TypeError, ValueError):
                raise BulkEditError(f"set_field {name}: not a number: {o.get('value')!r}")
            if s.get(name) != val:
                diffs.append(f"{name}: {s.get(name, '(default)')} → {val}")
                s[name] = val
        elif kind == "set_expected":
            field, cmp_ = o["field"], o.get("cmp", "==")
            if cmp_ not in EXPECT_OPS:
                raise BulkEditError(f"set_expected: cmp must be one of {list(EXPECT_OPS)}")
            new_check = {"field": field, "op": cmp_, "value": o.get("value")}
            checks = _expected_list(s)
            old = next((c for c in checks if c.get("field") == field), None)
            if old != new_check:
                checks = [c for c in checks if c.get("field") != field] + [new_check]
                desc = f"{field} {cmp_} {_short(o.get('value'))}"
                diffs.append(f"expect {field}: "
                             f"{(old['op'] + ' ' + _short(old.get('value'))) if old else '(none)'} → {desc}")
                s["expected"] = checks
        elif kind == "remove_expected":
            checks = _expected_list(s)
            kept = [c for c in checks if c.get("field") != o["field"]]
            if len(kept) != len(checks):
                diffs.append(f"expect {o['field']}: → (removed)")
                s["expected"] = kept or None
        else:
            raise BulkEditError(f"unknown op {kind!r}")
    return s, diffs


def plan(testcases, flt: dict, ops: list, exclude: set[str]):
    """For each testcase: (testcase, new_steps or None if unchanged, changes).
    changes: [{step_index, action, diffs, excluded}]. exclude holds
    "<testcase_id>:<step_index>" keys the user unticked in the preview."""
    if not ops:
        raise BulkEditError("no changes given")
    out = []
    for tc in testcases:
        steps = tc.steps
        new_steps, changes, changed = [], [], False
        for i, step in enumerate(steps):
            if not step_matches(step, flt):
                new_steps.append(step)
                continue
            edited, diffs = apply_ops(step, ops)
            if not diffs:
                new_steps.append(step)
                continue
            excluded = f"{tc.id}:{i}" in exclude
            changes.append({"step_index": i, "action": step.get("action"),
                            "diffs": diffs, "excluded": excluded})
            if excluded:
                new_steps.append(step)
            else:
                new_steps.append(edited)
                changed = True
        out.append((tc, new_steps if changed else None, changes))
    return out
