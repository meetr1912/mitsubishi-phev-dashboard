# Snow Guard model

**Purpose.** Snow Guard is a windshield-and-cabin preconditioning assistant for an outside-parked Outlander PHEV in Halifax. It is not an exterior snow-removal system. Cabin heat cannot reliably clear a roof, hood, trunk, mirrors, wheel arches, or packed snow around the wipers. Those surfaces still need to be cleared manually before driving.

**Hard vehicle limits.** Mitsubishi documents Remote Climate Control as a cabin function, not a continuous snow-melting system. A manual request normally has a 30-minute setting; vehicle behaviour can vary from roughly 30 minutes to two hours with battery level and charger state. After two consecutive remote-climate commands, Mitsubishi requires the vehicle to be driven above 8 km/h before more commands can be sent. The verified Android client payload exposes 10-, 20-, and 30-minute operation times, with the current Worker using 20 or 30 minutes. Snow Guard therefore reserves one automatic start per verified driven cycle. It never consumes the vehicle's second consecutive remote-climate command deliberately.

**Halifax operating context.** Halifax Stanfield's 1991–2020 normals report 215.2 cm of annual snowfall, 56 days with at least 0.2 cm, 13.4 days with at least 5 cm, and 6.1 days with at least 10 cm. February alone averages 44.3 cm; January averages 53.9 cm. The useful intervention is not “run whenever snow exists,” but “run when snow is likely to bond to glass or build fast enough to reduce visibility.” Near-freezing coastal snow is the key case: it is denser and more adhesive than cold dry snow.

**Lean heat calculation.** The latent heat of fusion of ice is 333.5 kJ/kg. A 1.3 m² windshield under 1 cm of new snow at 150 kg/m³ holds about 1.95 kg of snow. Warming it from -5°C to 0°C and melting it has an ideal lower bound:

`E = m × (c_ice × ΔT + L_f) = 1.95 × (2.1 × 5 + 333.5) ≈ 672 kJ = 0.19 kWh`

At 250 kg/m³ wet snow, the same depth is about 0.31 kWh before losses. Real energy use is materially higher because the climate system also warms cabin air, glass, trim, and continuously loses heat to wind and ambient air. The calculation explains the policy; it does not claim to predict the car's consumption from weather alone.

**Implemented decision model.** Every 15 minutes, Snow Guard reads current temperature, snowfall, WMO weather code, wind speed, and 15-minute snowfall forecasts for Halifax.

- Above 2.5°C: do nothing. The expected outcome is rain/slush, not useful snow removal.
- Cold, light snow: do nothing when the temperature is at or below -8°C and rate is below 1 cm/h. This snow usually has low bonding value; a remote climate cycle cannot justify its energy cost or remove the exterior accumulation.
- Wet/bonding snow: request 30 minutes when temperature is between -2°C and 1.5°C and the next-hour forecast is at least 0.4 cm. This is the highest-value windshield/wiper case.
- Heavy snow or wind-driven accumulation: request 30 minutes for at least 1.5 cm forecast in the next hour, or 0.5 cm/h with wind at or above 30 km/h.
- Moderate, adhesive snow: request 20 minutes when the three-hour forecast is at least 1.5 cm and adhesion risk is moderate.
- Before every action: require the car to be stationary, closed, sufficiently charged, and plugged in unless the owner deliberately relaxes that guardrail.
- After an automated request: send no further automated Remote Climate command until vehicle odometer movement proves that the car has been driven. The Worker samples that proof at most once per hour while an actionable event remains active.

**What changed from the original policy.** “Two runs per day” and “six-hour cooldown” were removed. They were arbitrary and could both waste a useful weather window and conflict with Mitsubishi's consecutive-command behaviour. The replacement is event-based weather scoring plus a drive-cycle reserve. It is stricter where the car itself is strict, and more responsive where weather makes a single preconditioning run worthwhile.

**Calibration plan.** The current inputs cannot observe glass temperature, actual exterior snow depth on the vehicle, charging power, or real HVAC energy draw. The next safe improvement is to record action time, battery before/after when unplugged, plug state, forecast snow, and user-confirmed outcome (“glass clear / partial / no benefit”). That can tune the thresholds to this exact vehicle without inventing thermal precision.

**Sources.**

1. Environment and Climate Change Canada, [Halifax Stanfield (Airport), 1991–2020 Climate Normals](https://climate.weather.gc.ca/climate_normals/results_1991_2020_e.html?climate_id=8202250&dispBack=0&lstProvince=&searchType=stnProv&stnID=251000000&txtCentralLatMin=0&txtCentralLatSec=0&txtCentralLongMin=0&txtCentralLongSec=0&wbdisable=true).
2. Mitsubishi Connect, [Safeguard and Remote Services Quick Start](https://www.mitsubishi-connect.com/en/SafeguardRemote/Manual/outlander_phev_Quick_US/contents/).
3. Mitsubishi Connect Support, [How to Set the Climate Remotely for Outlander and Outlander PHEV](https://connectedcarsupport.zendesk.com/hc/en-us/articles/360048565032-How-to-Set-the-Climate-Remotely-for-Outlander-and-Outlander-PHEV).
4. Mitsubishi Motors, [Outlander PHEV remote-operation instructions](https://www.mitsubishi-motors.com/en/products/outlander_phev/app/remote/operation.html).
5. N. S. Osborne, National Bureau of Standards, [Heat of Fusion of Ice: A Revision](https://nvlpubs.nist.gov/nistpubs/jres/23/jresv23n6p643_A1b.pdf), 1939.
6. R. M. West et al., [Seasonal evolution of snow density and its impact on thermal properties](https://tc.copernicus.org/articles/19/6001/2025/tc-19-6001-2025.pdf), *The Cryosphere*, 2025.
