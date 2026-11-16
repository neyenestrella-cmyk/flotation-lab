"""Servidor Flask. Ejecutar: python app.py. Producción: gunicorn app:app."""
import csv
import io
import json
import os
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request
from werkzeug.exceptions import BadRequest, UnsupportedMediaType

from model import Config, compare, metadata, simc

BASE = Path(__file__).resolve().parent
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024
app.json.ensure_ascii = False


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/health")
def health():
    return jsonify(status="ok", engine="Python", version=metadata()["version"])


@app.get("/api/meta")
def meta():
    return jsonify(metadata())


def read_config():
    data = request.get_json()
    if not isinstance(data, dict):
        raise ValueError("Envía un objeto JSON con la configuración.")
    return Config.from_dict(data)


@app.post("/api/simulate")
def simulation():
    return jsonify(compare(read_config()))


@app.get("/api/simc")
def simc_values():
    return jsonify(simc(int(request.args.get("cell", "0")), float(request.args.get("tau_c", "7"))))


@app.post("/api/export/<kind>")
def export(kind):
    if kind not in ("csv", "json"):
        return jsonify(error="Formato no reconocido."), 404
    result = compare(read_config())
    if kind == "json":
        content = json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False)
        mime = "application/json"
    else:
        buf = io.StringIO(newline="")
        writer = csv.writer(buf)
        writer.writerow(["estrategia", "tiempo_s", "celda", "consigna_cm", "nivel_real_cm",
                         "nivel_medido_cm", "entrada_L_min", "salida_real_L_min",
                         "mando_L_min", "mando_cuentas_PLC", "feedforward_L_min"])
        for strategy in ("feedback", "feedforward"):
            d = result[strategy]["data"]
            for k, t in enumerate(d["t"]):
                for i in range(3):
                    writer.writerow([strategy, t, i + 1] + [round(d[key][k][i], 8) for key in
                        ("setpoint", "level", "measured", "inlet", "outlet", "command", "bits", "ff")])
        content = "\ufeff" + buf.getvalue()
        mime = "text/csv; charset=utf-8"
    return Response(content, mimetype=mime, headers={
        "Content-Disposition": f'attachment; filename="flotationlab_resultados.{kind}"',
        "Cache-Control": "no-store",
    })


@app.get("/api/model-source")
def model_source():
    # Archivo fijo, sin rutas arbitrarias ni ejecución de código recibido.
    return Response((BASE / "model.py").read_text(encoding="utf-8"), mimetype="text/plain")


@app.errorhandler(ValueError)
@app.errorhandler(BadRequest)
@app.errorhandler(UnsupportedMediaType)
def bad_request(error):
    return jsonify(error=str(error) if isinstance(error, ValueError) else "JSON inválido: revisa los parámetros enviados."), 400


@app.errorhandler(413)
def too_large(_error):
    return jsonify(error="La petición supera el tamaño permitido."), 413


@app.after_request
def headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    return response


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"\nFlotationLab: http://127.0.0.1:{port}\nAbre esta dirección en Chrome. Ctrl+C para detener.\n")
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=port, debug=False)
