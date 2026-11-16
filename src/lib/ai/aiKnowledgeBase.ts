/**
 * Comprehensive Knowledge Base for WLM Agent
 * Distilled from docs/FORMULAS.md, application architecture, and plant operational SOPs.
 */

export const WLM_APP_NAVIGATION_GUIDE = `
[APPLICATION PAGES & NAVIGATION MATRIX]
The application has the following distinct pages and features. You can navigate users to any of these pages using the "navigate_to_page" tool:

1. "production" (Production Setup & Simulation):
   - The central workspace. Allows creating/editing multi-operator production setups, selecting machine layouts, assigning wires/constructions, configuring shift times, and launching the 8-hour discrete event simulation.
   - Sub-views: Setup Designer (planning) and Simulation Run (live replay & timeline).

2. "simulator" (WorkLoad Single-Setup Simulator):
   - Legacy/single setup operator task simulation for quick prototyping of individual machine layouts.

3. "layouts" (Machine Layout Manager):
   - Configure machine floor plans, machine row arrangements (Take-Up / TU and Pay-Off / PO positions), walkway aisles, and machine numbering (e.g. 1501-1520, 1601-1620, 1701-1720).

4. "products" (Product & Machine Specifications):
   - Catalog of wire constructions, linear density, wire counts, lay length, spool length, and machine operating speeds (rpm / m/min).

5. "activities" (Activities & Time Standards):
   - Standard cycle times and rules for operator tasks: Doffing, Loading, Welder, Fracture Repairing, Defect Repairing, Dies Change, and Cleaning.

6. "frequency" (Historical Defect & Fracture Frequencies):
   - Power BI semantic model data showing historical defect rates (Defect/Ton), wire fractures (Fr/Ton), and dies wear (Dies/Ton) across products.

7. "actualOutput" (Actual Output MES Data):
   - Actual production output, gross kilograms, and operator productivity imported from factory MES systems (WL_ActualOutput).

8. "rejectShort" (Reject & Short Length Non-Conformities):
   - MES historical records of short spool cuts, non-conforming wire rejects, and scrap losses.

9. "outputModels" (Saved Output Models):
   - Archive of saved simulation snapshots and historical benchmark runs.

10. "settings" (System & Plant Default Settings):
    - Plant parameters (shift times, break times), default cost factors, and WLM Agent AI Provider/API key configurations. Only Administrators can modify.

11. "guidance" (User Guide & Help Documentation):
    - In-app interactive documentation, terminology explanations, and operational guidelines (English & Bahasa Indonesia).

12. "users" (User Access & Role Management):
    - Admin portal for managing user permissions (Admin, Contribute, Guest).
`;

export const WLM_FORMULAS_KNOWLEDGE = `
[TECHNICAL FORMULAS & CALCULATION LOGIC (FORMULAS.md)]

1. MACHINE SPECIFICATIONS & RUNTIME:
   - Twist/min:
     * Areas WW, CH, CR, BA, CA, IS, IP -> Twist/min = 0 (linear drawing/stranding)
     * Areas SP, CB -> Twist/min = Speed (rpm)
     * Other bunching areas -> Twist/min = Speed * 2
   - Linear Speed (m/min):
     * Areas WW, CH, CR, BA, CA, IS, IP -> Linear Speed = Speed
     * Other areas -> Linear Speed = (LayLength / 1000) * Twist/min
   - Spool Weight (kg):
     * Spool Weight = (SpoolLength * LinearDensity * NoOfWires) / 1000
   - Runtime per Spool (minutes):
     * Runtime = (SpoolLength / LinearSpeed) + 0.65 min (0.65 min is fixed acceleration/deceleration overhead)

2. ACTIVITY FREQUENCIES & CYCLES:
   - Cycle (spools per event) = Denominator / Numerator
   - Events per spool = 1 / Cycle
   - Ton-based Automatic Activities:
     * Fracture Repairing: Numerator = Fr/Ton, Denominator = 1000 / SpoolWeight
     * Dies Change (WW, BA, CA): Numerator = Dies/Ton, Denominator = 1000 / SpoolWeight
     * Defect Repairing (CB, BU, SP, CH, CR): Numerator = Defect/Ton, Denominator = 1000 / SpoolWeight
     * Explanation: Frequency per ton is converted into spools-between-events based on spool weight in kg.
   - Pay-Off Loading Cycle:
     * Denominator = floor(POlength / SpoolLength)
     * For multiple pay-off lengths, partial loading activities (Partial 1, Partial 2) trigger staggered loading events.

3. FORECAST MAN OCCUPATION vs ACTUAL MAN OCCUPATION:
   - FORECAST MAN OCCUPATION (%) [Planning / Pre-Simulation]:
     * Calculated in the Setup editor before simulation.
     * Theoretical operator workload ratio = (Total Machine Activity Minutes / Net Shift Minutes) * 100%
     * Net Shift Minutes = ShiftTime - LunchTime - MeetingTime.
     * Ideal target: 80% - 90%. Below 70% is underloaded (labor cost waste); above 92% is overloaded (risk of delays & fatigue).
   - ACTUAL MAN OCCUPATION (%) [Post-Simulation]:
     * Measured during the 8-hour discrete event simulation replay.
     * Actual Man Occupation = Working % + Walking %
     * Working % = (Total Service Minutes [doffing + loading + repairs] / Elapsed Shift Minutes) * 100%
     * Walking % = (Walking Minutes / Elapsed Shift Minutes) * 100%
     * Idle % = (Idle Minutes / Elapsed Shift Minutes) * 100%
     * Note: Working % + Walking % + Idle % = 100%.

4. LABOR PRODUCTIVITY (MHPT - Manhour Per Ton):
   - Net Manhours = (OperatorCount * NetShiftMinutes) / 60
   - MHPT Total (h/ton) = Net Manhours / Total Production (ton)
   - MHPT FP (h/ton) = Net Manhours / Finish Product (ton)
   - Goal: Minimize MHPT while maintaining high equipment OEE. High OEE with very high MHPT indicates labor inefficiency.

5. EQUIPMENT OEE & LOSSES:
   - OEE (%) = Availability (%) * Quality (%)
   - Availability (%) = (Machine Running Minutes / Planned Shift Minutes) * 100%
   - Downtime Breakdown:
     * Working Downtime: Machine stopped while being serviced by operator (doffing, loading, repair).
     * Waiting Handling (%): Machine stopped waiting for an operator because the assigned operator is busy on another machine or walking.
     * Unscheduled stops: Mechanical/electrical breakdowns or wire fractures.

6. DISCRETE EVENT SIMULATOR ENGINE LOGIC:
   - Discrete Event Queue: Events (spool completion, wire breaks, shift breaks) are queued chronologically.
   - Machine Interference: When 2 or more machines in an operator's group stop simultaneously, the operator services them in priority order (Repairs > Doffing > Loading). Unattended machines experience "Waiting Handling" downtime.
   - Walking Matrix: Travel time between machine slots is calculated based on physical plant layout coordinates. Clustered machine assignments minimize walking minutes, whereas sprawling machine assignments (e.g. crossing 3 rows) cause high walking loss and elevated waiting handling.
`;
