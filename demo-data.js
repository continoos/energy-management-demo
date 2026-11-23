(() => {
    const chargerLimits = [60, 60, 120, 120, 120, 180, 180, 180, 240];
    const vehicleLimits = [45, 75, 90, 110, 130, 150, 175, 200, 250];
    const loads = [
        { id: 1, name: "Aydınlatma" },
        { id: 2, name: "Havalandırma" },
        { id: 3, name: "Klima ve Diğer Yardımcı Yükler" },
    ];
    const meters = Array.from({ length: 11 }, (_, index) => ({
        id: index + 1,
        site_id: 1,
        serial_number: index < 10 ? "SIM-" + String(index + 1).padStart(3, "0") : "SOLAR-001",
        name: index < 9 ? "DC Şarj Noktası " + (index + 1)
            : index === 9 ? "Tesis Yardımcı Tüketimi" : "Güneş Enerjisi Üretimi",
        direction: index === 10 ? "generation" : "consumption",
    }));
    const hourMs = 3600000;
    const rounded = value => Math.round(value * 1000) / 1000;

    function simulate(timestamp) {
        const seconds = timestamp / 1000;
        const hour = (timestamp % (24 * hourMs)) / hourMs;
        const daylight = Math.max(0, Math.sin(Math.PI * (hour - 6) / 12));
        const solar = hour > 6 && hour < 18 ? 250 * daylight * (0.9 + 0.1 * Math.sin(seconds / 180)) : 0;
        const chargers = chargerLimits.map((limit, index) => {
            const phase = (seconds + index * 53) % 600;
            const vehicle = (Math.floor((seconds + index * 53) / 600) + index) % vehicleLimits.length;
            const connected = phase < 390;
            const vehicleLimit = connected ? vehicleLimits[vehicle] : null;
            const fraction = Math.max(0, Math.min(1, phase / 45, (390 - phase) / 100));
            return {
                vehicle_plate: connected ? "SIM-" + String(index * 10 + vehicle + 1).padStart(4, "0") : null,
                vehicle_max_charging_kw: vehicleLimit,
                power: connected ? Math.min(limit, vehicleLimit) * fraction : 0,
            };
        });
        const auxiliary = [14, 32, 70].map((value, index) =>
            value * (0.85 + 0.15 * Math.sin(seconds / (50 + index * 30))));
        const powers = [...chargers.map(charger => charger.power),
            auxiliary.reduce((sum, power) => sum + power, 0), solar];
        const consumption = powers.slice(0, 10).reduce((sum, power) => sum + power, 0);
        return { chargers, auxiliary, powers, consumption, solar, net: consumption - solar };
    }

    function measurement(power, timestamp) {
        const voltage = 400 + 2 * Math.sin(timestamp / 15000);
        return {
            timestamp: new Date(timestamp).toISOString(),
            active_power_kw: rounded(power),
            voltage_v: rounded(voltage),
            current_a: rounded(power * 1000 / (Math.sqrt(3) * voltage * 0.95)),
        };
    }

    function hourly(day, now, selectPower) {
        const start = Date.parse(day + "T00:00:00Z");
        let total = 0;
        let covered = 0;
        const hours = Array.from({ length: 24 }, (_, hour) => {
            const from = start + hour * hourMs;
            const duration = Math.max(0, Math.min(hourMs, now - from));
            let energy = 0;
            for (let elapsed = 0; elapsed < duration; elapsed += 30000) {
                const span = Math.min(30000, duration - elapsed);
                energy += selectPower(simulate(from + elapsed + span / 2)) * span / hourMs;
            }
            total += energy;
            covered += duration;
            return {
                hour: new Date(from).toISOString(),
                consumption_kwh: duration ? rounded(energy) : null,
                average_import_kw: duration ? rounded(energy * hourMs / duration) : null,
                coverage_percent: rounded(duration / hourMs * 100),
            };
        });
        return {
            hours,
            consumption_kwh: covered ? rounded(total) : null,
            total_consumption_kwh: covered ? rounded(total) : null,
            coverage_percent: rounded(covered / (24 * hourMs) * 100),
            status: !covered ? "no_data" : covered === 24 * hourMs ? "complete" : "partial_data",
        };
    }

    function history(now, interval, selectPower) {
        const end = Math.floor(now / interval) * interval;
        return { measurements: Array.from({ length: 1800000 / interval }, (_, index) => {
            const timestamp = end - 1800000 + (index + 1) * interval;
            return measurement(selectPower(simulate(timestamp)), timestamp);
        }) };
    }

    window.dashboardDemo = {
        fetchData(path, signal) {
            signal?.throwIfAborted();
            const url = new URL(path, "https://demo.invalid");
            const now = Math.floor(Date.now() / 10000) * 10000;
            const day = url.searchParams.get("day") ?? new Date(now).toISOString().slice(0, 10);
            const current = simulate(now);
            const parts = url.pathname.split("/").slice(3);
            if (parts[0] === "meters" && parts.length === 1) return meters;
            if (parts[0] === "meters") {
                const id = Number(parts[1]);
                const load = parts[2] === "loads";
                if (load && !parts[3]) return id === 10 ? loads : [];
                const selectPower = load ? sample => sample.auxiliary[Number(parts[3]) - 1]
                    : sample => sample.powers[id - 1];
                const action = load ? parts[4] : parts[2];
                if (action === "latest") return measurement(selectPower(current), now);
                if (action === "history") return history(now, 10000, selectPower);
                if (action === "daily-consumption" || action === "hourly-consumption") {
                    return hourly(day, now, selectPower);
                }
            }
            if (parts[0] === "sites" && parts[1] === "1") {
                if (parts[2] === "power-history") {
                    const generation = url.searchParams.get("direction") === "generation";
                    return history(now, 30000, sample => generation ? sample.solar : sample.consumption);
                }
                if (parts[2] === "dc-chargers" && parts[3] === "latest") {
                    return current.chargers.map(({ power, ...vehicle }, index) => ({
                        ...vehicle, ...measurement(power, now),
                        name: meters[index].name, meter_id: index + 1, unit_id: index + 1,
                    }));
                }
                if (parts[2] === "grid-import") {
                    const report = hourly(day, now, sample => Math.max(0, sample.net));
                    return { ...report, import_kwh: report.consumption_kwh,
                        hours: report.hours.map(hour => ({ ...hour, import_kwh: hour.consumption_kwh })) };
                }
                if (parts[2] === "daily-consumption") {
                    const consumption = hourly(day, now, sample => sample.consumption);
                    const solar = hourly(day, now, sample => sample.solar);
                    return {
                        ...consumption, site_name: "Continoos Demo Tesisi", meter_count: 10,
                        meters_with_data: consumption.status === "no_data" ? 0 : 10,
                        complete_meters: consumption.status === "complete" ? 10 : 0,
                        meters_with_live_power: 10, active_power_kw: current.consumption,
                        generation_meter_count: 1, generation_meters_with_live_power: 1,
                        generation_hours: solar.hours, generation_kwh: solar.consumption_kwh,
                        generation_kw: current.solar, net_power_kw: current.net,
                    };
                }
            }
            throw Error("Demo endpoint unavailable: " + url.pathname);
        },
    };
})();
