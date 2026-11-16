"""Modelo educativo del banco de flotación de Quintanilla et al. (2023).

DOI: 10.1016/j.mex.2023.102081. Solo biblioteca estándar de Python.
Ver MODELO.md para ecuaciones, unidades, supuestos y diferencias con el ensayo.
La integración y ambos controladores se ejecutan aquí, nunca en JavaScript.
"""
from dataclasses import asdict, dataclass, fields
import math
import random
from statistics import median

MODEL_VERSION = "1.0.0"
GAIN = -0.001018  # cm / (s * (L/min)), tabla 2; NO es 1/área.
DELAYS = (7, 6, 3)  # s, tabla 2
PUMP_SLOPES = (0.0029, 0.0033, 0.0033)  # L/min por cuenta, figura 9
PUMP_MAX = tuple(slope * 28000 for slope in PUMP_SLOPES)
SCENARIOS = {
    "setpoint": "Cambio de consigna",
    "disturbance": "Perturbación de alimentación",
    "combined": "Consigna y perturbación",
    "equilibrium": "Equilibrio sin perturbaciones",
}


@dataclass(frozen=True)
class Config:
    scenario: str = "setpoint"
    duration: int = 900
    event_time: int = 180
    feed: float = 45.0
    feed_step: float = 15.0
    initial: tuple = (30.0, 34.0, 33.0)
    target: tuple = (29.0, 33.0, 32.0)
    kc: tuple = (-62.0, -76.0, -85.0)
    ti: tuple = (56.0, 30.0, 44.0)
    kff: tuple = (0.8, 0.8, 1.0)
    ff_mode: str = "literal"
    noise: float = 0.0  # desviación estándar, cm; ruido sintético opcional
    median_filter: bool = True
    seed: int = 2023

    @classmethod
    def from_dict(cls, data=None):
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise ValueError("La configuración debe ser un objeto JSON.")
        unknown = set(data) - {f.name for f in fields(cls)}
        if unknown:
            raise ValueError("Parámetros desconocidos: " + ", ".join(sorted(unknown)))
        values = asdict(cls())
        values.update(data)

        def number(name, value, low, high, integer=False):
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name}: se requiere un número.")
            if not math.isfinite(value) or not low <= value <= high:
                raise ValueError(f"{name}: debe estar entre {low} y {high}.")
            if integer and int(value) != value:
                raise ValueError(f"{name}: debe ser entero.")
            return int(value) if integer else float(value)

        for name, low, high, integer in [
            ("duration", 300, 1800, True), ("event_time", 30, 1500, True),
            ("feed", 10, 75, False), ("feed_step", -35, 35, False),
            ("noise", 0, 0.2, False), ("seed", 0, 2147483647, True),
        ]:
            values[name] = number(name, values[name], low, high, integer)
        for name, low, high in [
            ("initial", 20, 38), ("target", 20, 38),
            ("kc", -180, -5), ("ti", 5, 300), ("kff", 0, 1.5),
        ]:
            vector = values[name]
            if not isinstance(vector, (list, tuple)) or len(vector) != 3:
                raise ValueError(f"{name}: se requieren exactamente tres valores.")
            values[name] = tuple(number(name, v, low, high) for v in vector)
        if not isinstance(values["scenario"], str) or values["scenario"] not in SCENARIOS:
            raise ValueError("Escenario no reconocido.")
        if not isinstance(values["ff_mode"], str) or values["ff_mode"] not in ("literal", "sustained"):
            raise ValueError("Modo feedforward no reconocido.")
        if type(values["median_filter"]) is not bool:
            raise ValueError("median_filter debe ser verdadero o falso.")
        if values["scenario"] != "equilibrium" and values["event_time"] > values["duration"] - 60:
            raise ValueError("El evento debe ocurrir al menos 60 s antes del final.")
        if values["scenario"] in ("disturbance", "combined") and not 0 <= values["feed"] + values["feed_step"] <= 98:
            raise ValueError("El caudal después del cambio debe estar entre 0 y 98 L/min.")
        return cls(**values)


def schedule(config, t):
    """Señales externas idénticas para las dos estrategias comparadas."""
    sp = config.initial
    feed = config.feed
    if config.scenario in ("setpoint", "combined") and t >= config.event_time:
        sp = config.target
    disturbance_time = config.event_time
    if config.scenario == "combined":
        disturbance_time += (config.duration - config.event_time) // 2
    if config.scenario in ("disturbance", "combined") and t >= disturbance_time:
        feed += config.feed_step
    return sp, feed


def simulate(config, use_feedforward):
    """Control y muestreo cada 1 s; Euler exacto en intervalos de flujo constante.

    1. Recuperar flujos de salida demorados v_i[k] = u_i[k-theta_i].
    2. Encadenar q_in = (Q_feed, v_1, v_2); medir h y calcular PI/FF.
    3. Limitar u y evitar windup por integración condicional.
    4. h_i[k+1] = h_i[k] + abs(k') * (q_in_i[k] - v_i[k]) * 1 s.
    """
    rng = random.Random(config.seed)  # misma secuencia en ambas estrategias
    h = list(config.initial)
    integral = [0.0] * 3  # contribución integral en L/min
    ff = [0.0] * 3
    previous_inlet = [config.feed] * 3
    history = [[] for _ in range(3)]
    sensor_history = [[h[i]] * 9 for i in range(3)]
    data = {name: [] for name in ("t", "level", "measured", "setpoint", "inlet", "outlet", "command", "bits", "ff", "proportional", "integral", "error")}
    iae = [0.0] * 3
    ise = [0.0] * 3
    saturated = [0] * 3
    max_error = [0.0] * 3
    variation = [0.0] * 3
    outside = set()
    for k in range(config.duration + 1):
        sp, feed = schedule(config, k)
        outlet = [history[i][k - DELAYS[i]] if k >= DELAYS[i] else config.feed for i in range(3)]
        inlet = [feed, outlet[0], outlet[1]]
        commands, measurements, proportional, errors = [], [], [], []
        for i in range(3):
            # La ventana causal utiliza únicamente mediciones presentes y pasadas.
            measurement = h[i] + rng.gauss(0, config.noise)
            sensor_history[i].append(measurement)
            sensor_history[i] = sensor_history[i][-10:]
            if config.median_filter:
                measurement = median(sensor_history[i])
            measurements.append(measurement)
            error = sp[i] - measurement
            errors.append(error)
            proportional.append(config.kc[i] * error)
            delta_q = inlet[i] - previous_inlet[i]
            if not use_feedforward:
                ff[i] = 0.0
            elif config.ff_mode == "literal":
                ff[i] = config.kff[i] * delta_q  # ecuaciones 7-8 tal como se escriben
            else:
                ff[i] += config.kff[i] * delta_q  # extensión declarada: acumula cambios
            delta_i = config.kc[i] / config.ti[i] * error  # dt = 1 s
            candidate = integral[i] + delta_i
            raw = config.feed + config.kc[i] * error + candidate + ff[i]
            # Bloquear solamente la integración que empuja más allá del límite.
            if (raw > PUMP_MAX[i] and delta_i > 0) or (raw < 0 and delta_i < 0):
                candidate = integral[i]
                raw = config.feed + config.kc[i] * error + candidate + ff[i]
            integral[i] = candidate
            command = max(0.0, min(PUMP_MAX[i], raw))
            history[i].append(command)
            commands.append(command)
            true_error = sp[i] - h[i]
            max_error[i] = max(max_error[i], abs(true_error))
            if k < config.duration:
                # Sumas rectangulares: N intervalos, sin contar dos veces el final.
                iae[i] += abs(true_error)
                ise[i] += true_error * true_error
                saturated[i] += int(command <= 1e-9 or command >= PUMP_MAX[i] - 1e-9)
            if k > 0:
                variation[i] += abs(command - history[i][-2])
            if not 0 <= h[i] <= 45:
                outside.add(i + 1)
        for name, value in {
            "t": k, "level": h.copy(), "measured": measurements,
            "setpoint": list(sp), "inlet": inlet, "outlet": outlet,
            "command": commands, "bits": [commands[i] / PUMP_SLOPES[i] for i in range(3)],
            "ff": ff.copy(),
            "proportional": proportional, "integral": integral.copy(), "error": errors,
        }.items():
            data[name].append(value)
        if k < config.duration:
            h = [h[i] + abs(GAIN) * (inlet[i] - outlet[i]) for i in range(3)]
        previous_inlet = inlet.copy()
    metrics = [{
        "iae": iae[i], "ise": ise[i], "max_error": max_error[i],
        "final_error": data["setpoint"][-1][i] - data["level"][-1][i],
        "saturation_pct": 100 * saturated[i] / config.duration,
        "total_variation": variation[i],
    } for i in range(3)]
    return {"data": data, "metrics": metrics, "outside_domain": sorted(outside)}


def compare(config):
    feedback = simulate(config, False)
    feedforward = simulate(config, True)
    a = sum(m["iae"] for m in feedback["metrics"])
    b = sum(m["iae"] for m in feedforward["metrics"])
    events = []
    if config.scenario in ("setpoint", "combined"):
        events.append({"t": config.event_time, "label": "Cambio de consigna"})
    if config.scenario in ("disturbance", "combined"):
        t = config.event_time if config.scenario == "disturbance" else config.event_time + (config.duration - config.event_time) // 2
        events.append({"t": t, "label": "Cambio de alimentación"})
    warnings = []
    if feedback["outside_domain"] or feedforward["outside_domain"]:
        warnings.append("El nivel salió del rango físico 0–45 cm. La trayectoria continúa matemáticamente, pero no representa un tanque realizable; reduce el cambio o revisa la sintonía.")
    if any(m["saturation_pct"] > 10 for r in (feedback, feedforward) for m in r["metrics"]):
        warnings.append("Una bomba permanece saturada más del 10 % del ensayo. Revisa la demanda de caudal y los parámetros del controlador.")
    return {
        "model_version": MODEL_VERSION, "engine": "Python", "config": asdict(config),
        "dt": 1, "events": events, "feedback": feedback, "feedforward": feedforward,
        "summary": {"iae_feedback": a, "iae_feedforward": b,
                    "improvement_pct": 100 * (a - b) / a if a > 1e-10 else None},
        "warnings": warnings,
        "provenance": "Simulación educativa con parámetros publicados; no son datos experimentales ni una reproducción validada de la figura 14.",
    }


def metadata():
    return {
        "defaults": asdict(Config()), "scenarios": SCENARIOS,
        "gain": GAIN, "delays": DELAYS, "pump_max": PUMP_MAX,
        "pump_slopes": PUMP_SLOPES, "version": MODEL_VERSION,
        "article": {"doi": "10.1016/j.mex.2023.102081", "year": 2023,
                    "authors": "Quintanilla, Navia, Moreno, Neethling y Brito-Parada"},
    }


def simc(cell, tau_c):
    """Regla SIMC para integrador ideal; no sustituye el ajuste experimental."""
    if type(cell) is not int or not 0 <= cell <= 2:
        raise ValueError("Selecciona una celda entre 1 y 3.")
    if not math.isfinite(tau_c) or not 1 <= tau_c <= 120:
        raise ValueError("τc debe estar entre 1 y 120 s.")
    theta = DELAYS[cell]
    return {"kc": 1 / (GAIN * (tau_c + theta)), "ti": 4 * (tau_c + theta),
            "theta": theta, "robust": tau_c >= theta}
