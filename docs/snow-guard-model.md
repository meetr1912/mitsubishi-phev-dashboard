# Snow Guard model

**Purpose.** Snow Guard is a windshield-and-cabin preconditioning assistant for an outside-parked Outlander PHEV in Halifax. It is not an exterior snow-removal system. Cabin heat cannot reliably clear a roof, hood, trunk, mirrors, wheel arches, or packed snow around the wipers. Those surfaces still need to be cleared manually before driving.

**Hard vehicle limits.** Mitsubishi documents Remote Climate Control as a cabin function, not a continuous snow-melting system. A manual request normally has a 30-minute setting; vehicle behaviour can vary from roughly 30 minutes to two hours with battery level and charger state. Mitsubishi says PHEV remote climate must not be used below -15°C and may start the engine below -10°C. Snow Guard hard-stops below -15°C and requires an explicit acknowledgement for -10°C to -15°C; it also requires an outdoor-parking confirmation. After two consecutive remote-climate commands, Mitsubishi requires the vehicle to be driven above 8 km/h before more commands can be sent. The verified Android client payload exposes 10-, 20-, and 30-minute operation times, with the current Worker using 20 or 30 minutes. Snow Guard reserves one automatic start until fresh odometer movement indicates a new drive cycle. This is conservative but cannot observe climate commands made in Mitsubishi's own app.

**Halifax operating context.** Halifax Stanfield's 1991–2020 normals report 215.2 cm of annual snowfall, 56 days with at least 0.2 cm, 13.4 days with at least 5 cm, and 6.1 days with at least 10 cm. February alone averages 44.3 cm; January averages 53.9 cm. The useful intervention is not “run whenever snow exists,” but “run when snow is likely to bond to glass or build fast enough to reduce visibility.” Near-freezing coastal snow is the key case: it is denser and more adhesive than cold dry snow.

**Lean heat calculation.** The latent heat of fusion of ice is 333.5 kJ/kg. A 1.3 m² windshield under 1 cm of new snow at 150 kg/m³ holds about 1.95 kg of snow. Warming it from -5°C to 0°C and melting it has an ideal lower bound:

`E = m × (c_ice × ΔT + L_f) = 1.95 × (2.1 × 5 + 333.5) ≈ 672 kJ = 0.19 kWh`

At 250 kg/m³ wet snow, the same depth is about 0.31 kWh before losses. Real energy use is materially higher because the climate system also warms cabin air, glass, trim, and continuously loses heat to wind and ambient air. The calculation explains the policy; it does not claim to predict the car's consumption from weather alone.

**Implemented decision model.** Every 15 minutes, Snow Guard combines a 15-minute model forecast with Environment and Climate Change Canada’s 1 km live radar precipitation phase and snow-rate evidence for Halifax. It reads current temperature, wet-bulb temperature (or a documented fallback estimate), dew point, humidity, precipitation/rain/snowfall, WMO code, wind/gusts, and 15-minute forecast accumulation. Weather data that are incomplete, stale, or lack fresh radar evidence are shown but cannot start the vehicle.

- Above 2.5°C: do nothing. The expected outcome is rain/slush, not useful snow removal.
- Cold, light snow: do nothing when the temperature is at or below -8°C and rate is below 1 cm/h. This snow usually has low bonding value; a remote climate cycle cannot justify its energy cost or remove the exterior accumulation.
- Mixed or freezing precipitation: do nothing automatically. The dashboard reports that manual ice removal is required.
- Wet/bonding snow: request 30 minutes when wet-bulb conditions indicate bonding risk, the next-hour forecast is at least 0.4 cm, and fresh radar confirms snow at the location. This is the highest-value windshield/wiper case.
- Heavy snow or wind-driven accumulation: request 30 minutes for at least 1.5 cm forecast in the next hour, or 0.5 cm/h with wind at or above 30 km/h.
- Moderate, adhesive snow: request 20 minutes only when the snow is in the near-term window; a three-hour total alone cannot spend the one-command reserve hours too early.
- Before every action: require explicit outdoor parking consent, fresh high-confidence weather/radar, a stationary vehicle, all four reported doors closed, sufficient battery, and plugged-in state unless the owner deliberately relaxes that guardrail. Missing vehicle state fails closed.
- After an automated request: send no further automated Remote Climate command until odometer movement indicates a drive cycle. The Worker samples that indication at most once per hour while an actionable event remains active.

**What changed from the original policy.** “Two runs per day” and “six-hour cooldown” were removed. They were arbitrary and could both waste a useful weather window and conflict with Mitsubishi's consecutive-command behaviour. The replacement is event-based weather scoring plus a drive-cycle reserve. It is stricter where the car itself is strict, and more responsive where weather makes a single preconditioning run worthwhile.

**Calibration.** After a confirmed automated climate cycle ends, the dashboard offers one-tap feedback: “clear,” “partly clear,” or “no benefit.” The Worker stores only a bounded 365-day/120-case set of action time, requested duration, battery/plug state at start, a compact weather receipt, and the selected outcome. It never stores a VIN, GPS location, raw vehicle response, credentials, or free text. Feedback produces an evidence summary after ten responses; it does **not** auto-tune thresholds. Any threshold change remains a deliberate, reviewable safety decision.

**Sources.**

1. Environment and Climate Change Canada, [Halifax Stanfield (Airport), 1991–2020 Climate Normals](https://climate.weather.gc.ca/climate_normals/results_1991_2020_e.html?climate_id=8202250&dispBack=0&lstProvince=&searchType=stnProv&stnID=251000000&txtCentralLatMin=0&txtCentralLatSec=0&txtCentralLongMin=0&txtCentralLongSec=0&wbdisable=true).
2. Mitsubishi Connect, [Safeguard and Remote Services Quick Start](https://www.mitsubishi-connect.com/en/SafeguardRemote/Manual/outlander_phev_Quick_US/contents/).
3. Mitsubishi Connect Support, [How to Set the Climate Remotely for Outlander and Outlander PHEV](https://connectedcarsupport.zendesk.com/hc/en-us/articles/360048565032-How-to-Set-the-Climate-Remotely-for-Outlander-and-Outlander-PHEV).
4. Mitsubishi Motors, [Outlander PHEV remote-operation instructions](https://www.mitsubishi-motors.com/en/products/outlander_phev/app/remote/operation.html).
5. N. S. Osborne, National Bureau of Standards, [Heat of Fusion of Ice: A Revision](https://nvlpubs.nist.gov/nistpubs/jres/23/jresv23n6p643_A1b.pdf), 1939.
6. R. M. West et al., [Seasonal evolution of snow density and its impact on thermal properties](https://tc.copernicus.org/articles/19/6001/2025/tc-19-6001-2025.pdf), *The Cryosphere*, 2025.
7. Environment and Climate Change Canada, [MSC GeoMet radar data and point-query documentation](https://eccc-msc.github.io/open-data/msc-data/obs_radar/readme_radar_geomet_en/).
8. Open-Meteo, [Weather Forecast API variable and temporal-resolution documentation](https://open-meteo.com/en/docs).
