"""Oxide Studio: límite de profundidad para los formateadores de Rust en LLDB.

Los resúmenes genéricos de structs/tuplas de Rust (lldb_providers.py) se llaman
entre sí sin límite. Con tipos recursivos (p. ej. los de Slint) eso agota la pila
de Python y mata a lldb-dap. Aquí se envuelven con un contador de profundidad.
"""
import lldb_lookup as _lookup
import lldb_providers as _providers

_MAX_DEPTH = 4
_state = {"depth": 0}


def _guard(fn):
    if getattr(fn, "_oxide_guarded", False):
        return fn

    def wrapper(valobj, _dict):
        if _state["depth"] >= _MAX_DEPTH:
            return "{…}"
        _state["depth"] += 1
        try:
            return fn(valobj, _dict)
        except Exception:
            return "{…}"
        finally:
            _state["depth"] -= 1

    wrapper._oxide_guarded = True
    wrapper.__name__ = fn.__name__
    return wrapper


for _name in ("StructSummaryProvider", "TupleSummaryProvider"):
    _guarded = _guard(getattr(_providers, _name))
    # lldb_providers se llama a sí mismo por estos nombres y LLDB los busca en lldb_lookup.
    setattr(_providers, _name, _guarded)
    setattr(_lookup, _name, _guarded)


def __lldb_init_module(debugger, _dict):
    pass
