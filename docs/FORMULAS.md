# Matriks Formula — WorkLoad Simulator

Dokumen ini merangkum **semua formula kalkulasi** di aplikasi, dari spesifikasi mesin (Twist/min,
Linear Speed, Spool Weight) sampai forecast Man Occupation, engine simulasi Workload & Production,
dashboard, dan Production Report. Setiap bagian menyebut file sumbernya — jika formula di kode
berubah, perbarui tabel yang sesuai.

**Isi**

1. [Konvensi & simbol](#1-konvensi--simbol)
2. [Spesifikasi mesin](#2-spesifikasi-mesin)
3. [Aktivitas: frekuensi & siklus](#3-aktivitas-frekuensi--siklus)
4. [Waktu shift & break](#4-waktu-shift--break)
5. [Forecast Man Occupation — Workload Setup](#5-forecast-man-occupation--workload-setup)
6. [Output Estimate — Workload Setup](#6-output-estimate--workload-setup)
7. [Engine simulasi — Workload](#7-engine-simulasi--workload)
8. [Dashboard simulasi — Workload](#8-dashboard-simulasi--workload)
9. [Save WLM (WL_Outputmodels)](#9-save-wlm-wl_outputmodels)
10. [Planned Utilization — Production Setup](#10-planned-utilization--production-setup)
11. [Engine simulasi — Production](#11-engine-simulasi--production)
12. [Dashboard — Production Run](#12-dashboard--production-run)
13. [Production Report](#13-production-report)
14. [Konstanta](#14-konstanta)

---

## 1. Konvensi & simbol

| Simbol | Arti | Satuan |
|---|---|---|
| `Area` | Kode area produk (BU, CB, SP, CH, CR, WW, BA, CA, IS, IP) | – |
| `Speed` | Kecepatan mesin (WL_Products) | rpm atau m/min (lihat §2) |
| `LayLength` | Lay length | mm |
| `SpoolLength` | Panjang per spool | m |
| `LinearDensity` | Berat per meter per kawat | g/m |
| `NoOfWires` | Jumlah kawat | – |
| `Fr/Ton`, `Dies/Ton`, `Defect/Ton` | Kejadian per ton | kejadian/ton |
| `POlength1..3` | Pay-off length (m; **kg** untuk WW/BA/CA/IS/IP) | m / kg |
| `ShiftTime`, `LunchTime`, `MeetingTime` | Durasi shift & break | menit |
| `N` | Jumlah mesin yang di-assign | – |
| `cycle` | Siklus aktivitas, dalam **jumlah spool** antar kejadian | spool |
| `time` | Waktu aktivitas (WL_Activities) | menit |

Semua waktu simulasi dalam **menit sejak awal shift**. Jam dinding = `Shift start + menit` (format 24 jam).

---

## 2. Spesifikasi mesin

Sumber: [`src/lib/calculations.ts`](../src/lib/calculations.ts) — `deriveMachineSpec`

| Hasil | Formula | Catatan |
|---|---|---|
| **Twist/min** | WW, CH, CR, BA, CA, IS, IP → `0`  ·  SP, CB → `Speed`  ·  Area lain → `Speed × 2` | |
| **Linear Speed** (m/min) | WW, CH, CR, BA, CA, IS, IP → `Speed`  ·  Area lain → `LayLength / 1000 × Twist/min` | |
| **Spool Weight** (kg) | `SpoolLength × LinearDensity × NoOfWires / 1000` | |
| **Runtime/spool** (menit) | `SpoolLength / LinearSpeed + 0.65` (0 bila LinearSpeed = 0) | 0.65 = waktu tetap per spool |

---

## 3. Aktivitas: frekuensi & siklus

Sumber: [`src/lib/calculations.ts`](../src/lib/calculations.ts), [`src/lib/productCatalog.ts`](../src/lib/productCatalog.ts)

### 3.1 Siklus umum

| Hasil | Formula |
|---|---|
| **Cycle** (spool per kejadian) | `Denominator / Numerator` (∞ bila salah satunya ≤ 0) |
| **Kejadian per spool** | `1 / cycle` |
| **Due count** (engine) | `floor(spoolsCompleted / cycle)` — aktivitas dijadwalkan saat due count > yang sudah ditangani |

### 3.2 Aktivitas berbasis ton (numerator/denominator otomatis)

| Aktivitas | Berlaku untuk Area | Numerator | Denominator |
|---|---|---|---|
| Fracture Repairing | semua | `Fr/Ton` | `1000 / SpoolWeight` |
| Dies Change | WW, BA, CA | `Dies/Ton` | `1000 / SpoolWeight` |
| Defect Repairing | CB, BU, SP, CH, CR | `Defect/Ton` | `1000 / SpoolWeight` |

Artinya siklus = `(1000 / SpoolWeight) / (per ton)` spool per kejadian — atau setara `per ton × ton`.

### 3.3 Loading (regulasi POlength)

Sumber: `buildLoadingActivities`, `rebuildLoadingActivities` di `productCatalog.ts`.

| Kondisi | Loading (parent) | Sub-loading |
|---|---|---|
| Area WW/BA/CA/IS/IP (POlength = kg) | Denominator = `POlength pertama yang terisi / SpoolWeight` (desimal); engine memicu Loading dari progres fraksional (bisa memotong spool) | tidak ada |
| 1 POlength terisi | Denominator = `ROUNDDOWN(POlength / SpoolLength)` | tidak ada |
| 2 POlength terisi | Denominator = `ROUNDDOWN(max POlength / SpoolLength)` | **Partial1**: Denominator = `ROUNDDOWN(POlength lain / SpoolLength)` |
| 3 POlength terisi | sama (pakai max) | Dua sisanya: `ROUNDDOWN(PO/SpoolLength)`. Bila sama → hanya Partial1. Bila beda → yang kecil **Partial1**, yang besar **Partial2**; ditambah **Partial3** (dikerjakan bila Partial1 & Partial2 jatuh bersamaan) |
| Tidak ada POlength | Loading & sub dari baris WL_Activities apa adanya | |

Semua Numerator Loading = 1. Waktu & Stop/Run dari WL_Activities. Mengubah POlength/SpoolLength/SpoolWeight di form Spec menghitung ulang Loading (waktu & Stop/Run yang sudah diedit dipertahankan).

### 3.4 Aturan sub-aktivitas

| Sub dari | Perilaku di engine |
|---|---|
| **Loading** (Partial) | Pengganti Loading: hanya dijadwalkan di spool ketika Loading penuh **tidak** jatuh tempo |
| Aktivitas lain (mis. Doffing ScanMES) | Dijalankan **setiap kali** jatuh tempo, sesudah parent-nya |

---

## 4. Waktu shift & break

Sumber: `availableTimeMinutes`, `extraBreakMinutes` di `calculations.ts`

| Hasil | Formula |
|---|---|
| **Available Time** | `max(0, ShiftTime − LunchTime − MeetingTime − Σ OtherN Time)` |
| Break (Lunch, Meeting, OtherN) | Dimulai pada menit `startAt` — operator menyelesaikan task yang sedang berjalan dulu, lalu break selama `time` menit |

Other break hanya di Workload Setup; Production Setup hanya Lunch & Meeting.

---

## 5. Forecast Man Occupation — Workload Setup

Sumber: [`src/lib/singleOperatorUtilization.ts`](../src/lib/singleOperatorUtilization.ts) — `calculateSingleOperatorForecast`. Model deterministik 1 operator untuk semua mesin yang di-assign.

| # | Hasil | Formula |
|---|---|---|
| 1 | Expected spools per mesin | `ShiftTime / Runtime/spool` |
| 2 | Menit stop per spool | `Σ (aktivitas Stop) time / cycle` — Dies Change: `time / (cycle × 16.5)` |
| 3 | **Forecast scale** (fraksi kapasitas) | `Runtime / (Runtime + menit stop per spool)` |
| 4 | Kejadian per mesin (aktivitas per-mesin) | `ExpectedSpools / cycle` |
| 5 | Kejadian global (Fracture, Dies, Defect) | `(ExpectedSpools × N) / cycle` — dihitung sekali untuk seluruh line |
| 6 | Dies Change | quantity = `spools / cycle` (dies); event = `quantity / 16.5`; menit = `quantity × time` |
| 7 | **Planned minutes** | `Σ kejadian × time` (semua aktivitas) |
| 8 | **Forecast service minutes** | `Planned minutes × Forecast scale` |
| 9 | Kunjungan per mesin | `max(kejadian aktivitas di mesin) × scale` |
| 10 | **Forecast walking minutes** | Rute: mesin diurutkan dari jarak ke titik start. `(jarak first pass + max(0, rata-rata kunjungan − 1) × jarak satu putaran) / WalkingSpeed` |
| 11 | Busy | `Service + Walking` |
| 12 | **Forecast waiting (backlog)** | `max(0, Busy − Available)` |
| 13 | Ideal demand % | `Planned / Available × 100` |
| 14 | **Forecast Man Occupation %** | `min(100, Busy / Available × 100)` |
| 15 | Expected finished spools | `ExpectedSpools × N × scale` |
| 16 | **Optimize (#Assigned Machines)** | Jumlah mesin **terbesar** (1…jumlah layout) yang forecast waiting-nya ≤ 0 |

Jarak = jarak Euclidean pixel ÷ `pixelsPerMeter`.

---

## 6. Output Estimate — Workload Setup

Sumber: [`src/components/setup/OutputEstimate.tsx`](../src/components/setup/OutputEstimate.tsx)

| Hasil | Formula |
|---|---|
| Planned machine minutes | `N × ShiftTime` |
| Machine minutes sebelum waiting | `Expected finished spools × Runtime` |
| Waiting minutes | `min(Planned machine minutes, Forecast waiting)` |
| Produced machine minutes | `max(0, sebelum waiting − waiting)` |
| **#Spool** | `Produced machine minutes / Runtime` |
| **Tonage** | `#Spool × SpoolWeight / 1000` |
| Total downtime | `min(Planned, Σ menit aktivitas Stop + waiting)` |
| **Availability / OEE** | `(Planned − Downtime) / Planned × 100` |
| OEE (finished spool) | `Produced / Planned × 100` |
| **Manhour/ton** | `ShiftHours / Tonage` (1 operator) |
| **Machhours/ton** | `N × ShiftHours / Tonage` |
| Fracture/Dies/Defect per ton (estimate) | `Σ (#Spool / cycle) / Tonage` |
| Idle | `max(0, Available − Service − Walking)` |

---

## 7. Engine simulasi — Workload

Sumber: [`src/lib/simulationEngine.ts`](../src/lib/simulationEngine.ts)

### 7.1 Waktu & inisialisasi

| Hal | Formula / aturan |
|---|---|
| Waktu simulasi | `menit sim = detik nyata × kecepatan × 2` (1× = 2 menit/detik) |
| Sub-step | 0.01 menit |
| Theoretical spools/shift | `max(1, floor(ShiftTime / Runtime))` |
| Fase awal mesin | `startSpools = floor(random × max(TheoreticalSpools, ceil(cycle terpanjang)))`; progres spool awal acak `random × Runtime` |
| Loading berbasis berat | fase awal acak `random × cycle Loading` |
| Backlog awal | 30% mesin mulai dengan satu spool selesai yang menunggu servis |
| Planned dies | `TheoreticalSpools × N × SpoolWeight × Dies/Ton / 1000` |

### 7.2 Produksi & antrean

| Hal | Aturan |
|---|---|
| Spool selesai | Hanya mesin **running**; setiap `Runtime` menit → spool +1 → cek aktivitas jatuh tempo (§3.1) |
| Task Stop | Mesin berhenti (`needs-service`) & produksi dibekukan sampai diservis |
| Task Run | Mesin tetap produksi selama diservis |
| **Downtime per task** | Task dihitung downtime bila task itu Stop, **atau** task berikutnya dalam kunjungan yang sama Stop; menit = `time` task |
| **Waiting** | Setiap menit mesin berhenti & belum diservis → downtime "Waiting for Operator" |

### 7.3 Kejadian global (Fracture, Dies, Defect)

| Hal | Formula |
|---|---|
| Spool fraksional line | `Σ spool selesai + Σ (mesin running) progres spool saat ini (0–1)` |
| Siklus event | Fracture/Defect: `cycle`. Dies: `(TheoreticalSpools × N) / ceil(PlannedDies / 16.5)` |
| Pemicu | Selama `spool fraksional ≥ (event terpicu + 1) × siklus` → pasang task di mesin running acak (efektif setelah spool mesin itu selesai) |
| Dies per event | 7 atau 26 (acak 50/50), dibatasi sisa planned dies; waktu = `time × jumlah dies` |

### 7.4 Loading berbasis berat (WW/BA/CA/IS/IP)

Dipicu saat `spoolsSinceLoading + progres spool saat ini ≥ cycle Loading` → mesin langsung berhenti (memotong spool). `spoolsSinceLoading` direset setelah Loading/sub-Loading selesai.

### 7.5 Pemilihan task (Task Priority)

| Mode | Skor terkecil yang dipilih |
|---|---|
| **Nearest Task** | Jarak jalan (m) dari posisi operator ke mesin |
| **Quickest Task** | `jalan ke zona pertama / WalkingSpeed + Σ dwell zona + Σ jalan antar zona / WalkingSpeed` |

Jalan mengikuti rute yang menghindari badan mesin. Waktu servis dibagi ke zona mesin (Pay Off, Take Up, dst.); untuk Loading, sub-Loading, Fracture, dan Defect (bukan take-up-only), waktu jalan antar zona **termasuk** dalam `time` aktivitas: `dwell = max(0, time − waktu jalan antar zona)` dibagi proporsional per zona.

### 7.6 Estimate kejadian (Completed Activities "/ ~N")

| Hal | Formula |
|---|---|
| Kejadian per spool | `1/cycle`; untuk sub dengan parent: dikurangi `1/LCM(cycle, cycle parent)` (lihat catatan) |
| Spool per mesin | `ShiftTime / (Runtime + Σ Stop: kejadian/spool × time)` (tanpa Dies) |
| Estimate | `round(Spool/mesin × N × kejadian/spool)`; Dies: `ceil(PlannedDies / 16.5)` |

> **Catatan:** estimate Workload mengurangi overlap parent untuk **semua** sub-aktivitas, padahal engine hanya menggantikan parent untuk sub **Loading** (§3.4). Estimate sub non-Loading (mis. Doffing ScanMES) di Workload karena itu terlalu kecil. Estimate Production (§12.5) sudah memakai aturan yang benar.

---

## 8. Dashboard simulasi — Workload

Sumber: [`src/components/simulation/Dashboard.tsx`](../src/components/simulation/Dashboard.tsx)

| Hasil | Formula |
|---|---|
| Worked elapsed | `Clock − Break elapsed` |
| **Man Occupation %** | `(Walking + Servicing) / Worked elapsed × 100` |
| Walking / Service / Idle % | `menit / Worked elapsed × 100` |
| Rekomendasi #Mach | `round(N × Target% / Man Occupation%) − N` |
| Planned production | `N × Clock` |
| **Availability = OEE** | `(Planned − Σ downtime) / Planned × 100` (Performance & Quality 100%) |
| Rata-rata waktu tunggu | `Σ waktu tunggu / jumlah kunjungan` |
| **Output (finished spool)** — #Spool | jumlah Doffing selesai |
| Tonage | `#Spool × SpoolWeight / 1000` |
| OEE (finished spool) | `#Spool × Runtime / (N × ShiftTime) × 100` |
| Manhour/ton | `ShiftHours / Tonage` |
| Machhours/ton | `N × ShiftHours / Tonage` |
| Fracture/Dies/Defect per ton | `jumlah kejadian (dies: jumlah dies) / Tonage` |
| **Output (running time)** — running minutes | `Σ segmen timeline Running / Running + task` semua mesin |
| #Spool (running time) | `Running minutes / Runtime` (boleh desimal) |
| Tonage (running time) | `#Spool × SpoolWeight / 1000` |
| OEE (running time) | `Running minutes / (N × ShiftTime) × 100` |
| Per ton (running time) | sama seperti di atas dengan Tonage running time |

---

## 9. Save WLM (WL_Outputmodels)

Sumber: [`src/lib/outputModel.ts`](../src/lib/outputModel.ts) — `buildOutputModelPayload`

| Kolom | Formula |
|---|---|
| Twist/min, Spool weight, Linear speed, Runtime/spool | §2 |
| Planned machine efficiency | `(N × ShiftTime − min(N × ShiftTime, Σ downtime forecast + waiting forecast)) / (N × ShiftTime) × 100` |
| Actual man occupation | `(Walking + Servicing) / (Clock − Break) × 100` |
| Total spool | `Running minutes / Runtime` |
| Tonage | `Total spool × SpoolWeight / 1000` |
| Actual machine efficiency | `Running minutes / (N × ShiftTime) × 100` |
| Actual Fracture/Defect/Dies per ton | `jumlah / Tonage` |

---

## 10. Planned Utilization — Production Setup

Sumber: [`src/lib/productionUtilization.ts`](../src/lib/productionUtilization.ts). Sama dengan §5 tetapi **per operator** dan **per Construction**.

| # | Hasil | Formula |
|---|---|---|
| 1 | Expected spools per mesin | `ShiftTime / Runtime` (Construction mesin itu) |
| 2 | Forecast scale per mesin | `Runtime / (Runtime + menit stop per spool)` (§5 #2–3) |
| 3 | Aktivitas per-mesin | kejadian = `ExpectedSpools / cycle` → menit → ke operator yang di-assign untuk family aktivitas itu |
| 4 | Aktivitas global per Construction | kejadian = `Σ ExpectedSpools grup / cycle`, dibagi ke mesin menurut `share = ExpectedSpools mesin / Σ grup` |
| 5 | Routing operator | Doffing/Loading/Fracture ke operatornya; **Dies & Defect** ke operatornya, atau ke operator Fracture bila kosong |
| 6 | Planned, Service, Walking, Waiting, Occupation % | per operator, formula §5 #7–14 |
| 7 | Menit tanpa operator | dijumlah sebagai `unassignedMinutes` |
| 8 | **Selection occupation** (panel Assign) | Menjalankan #1–6 hanya untuk mesin terpilih: "All Task" = 1 operator mengerjakan semua; per family = 1 operator per family |

---

## 11. Engine simulasi — Production

Sumber: [`src/lib/productionSimulationEngine.ts`](../src/lib/productionSimulationEngine.ts). Aturan sama dengan §7 kecuali:

| Hal | Perbedaan dari Workload |
|---|---|
| Sub-step | 0.02 menit |
| Spec per mesin | Runtime, SpoolWeight, siklus, aktivitas dari Construction masing-masing |
| Fase awal mesin | Sama dengan §7.1, memakai Runtime & siklus Construction mesin itu |
| Backlog awal | **Tidak ada** (Workload: 30% mesin) |
| Kejadian global | Dihitung **per Construction** (spool fraksional grup mesin Construction itu); dipasang di mesin running acak dalam grup |
| Planned dies per Construction | `N grup × (ShiftTime / max(1, Runtime)) × SpoolWeight × Dies/Ton / 1000` (tanpa floor) |
| Operator | Banyak operator; setiap task punya operator dari assignment (§10 #5). Operator hanya memindai mesin yang di-assign ke dirinya |
| Loading oleh operator berbeda | Loading ditahan sampai Doffing (milik operator lain) di mesin itu selesai |
| Tonase doffed | Setiap Doffing selesai: `+ SpoolWeight` mesin itu, juga dicatat per Construction |

---

## 12. Dashboard — Production Run

Sumber: [`src/components/production/ProductionRunView.tsx`](../src/components/production/ProductionRunView.tsx)

### 12.1 Reject & Quality

| Hasil | Formula |
|---|---|
| **Quality** | `1 − %Reject / 100` |
| Good tonnage | `Gross tonnage × Quality` |
| Reject tonnage | `Gross − Good` |

### 12.2 Output (finished spool)

| Hasil | Formula |
|---|---|
| #Spool | jumlah Doffing selesai |
| Gross tonage | `Σ tonase doffed / 1000` |
| **Tonage (good)** | `Gross × Quality` |
| **Ton FP** | tonase good dari Construction dengan SpoolType diawali **BS** (BS40, BS80, "BS 80") |
| **Ton SFP** | `Tonage − Ton FP` |
| OEE (finished spool) | `Σ Runtime spool doffed / (N × ShiftTime) × 100 × Quality` |
| Manhour/ton  ·  ÷ Ton FP | `Operator × ShiftHours / Tonage`  ·  `/ Ton FP` |
| Machhours/ton  ·  ÷ Ton FP | `N × ShiftHours / Tonage`  ·  `/ Ton FP` |
| Fracture/Dies/Defect per ton  ·  ÷ Ton FP | `jumlah / Tonage`  ·  `/ Ton FP` |

`Operator` = operator yang punya minimal satu mesin ter-assign.

### 12.3 Output (running time)

| Hasil | Formula |
|---|---|
| Running minutes | `Σ segmen Running` semua mesin |
| #Spool | `Σ running minutes mesin / Runtime mesin` |
| Gross tonage | `Σ #Spool mesin × SpoolWeight mesin / 1000`; FP dipisah per Construction mesin |
| Tonage (good), Ton FP, Ton SFP | seperti §12.2 |
| OEE (running time) | `Running minutes / (N × ShiftTime) × 100 × Quality` |
| Per ton (÷ Ton, ÷ Ton FP) | seperti §12.2 dengan tonase running time |

### 12.4 OEE & Man Occupation

| Hasil | Formula |
|---|---|
| Planned production | `N × Clock` |
| **Availability** | `(Planned − Σ downtime) / Planned` |
| **OEE** | `Availability × Quality` (Performance 100%) |
| Man Occupation per operator | `(Walking + Service) / (elapsed − break)`; break = Lunch, Meeting, Other |
| Theoretical required minutes | `Σ mesin: (Clock / Runtime) / cycle × time` untuk Doffing, Loading, Fracture |
| Rekomendasi operator | `Required minutes / (menit tersedia per operator × Target%) − jumlah operator` |

### 12.5 Completed Activities estimate ("/ ~N")

Sumber: [`src/lib/productionEstimate.ts`](../src/lib/productionEstimate.ts). Rumus §7.6 **per Construction** lalu dijumlah, dengan koreksi: overlap parent hanya dikurangi untuk sub **Loading**. Dies: `ceil(PlannedDies Construction / 16.5)`. Dibulatkan setelah dijumlah.

### 12.6 Ringkasan timeline

Persentase di bawah Operator/Machine Timeline = `menit segmen / (Clock × jumlah baris)`; dikelompokkan per **nama aktivitas** (sub-aktivitas yang sama dari Construction berbeda digabung).

---

## 13. Production Report

Sumber: [`src/lib/productionReport.ts`](../src/lib/productionReport.ts). Dihitung dari snapshot saat Report dibuka; hanya mesin yang punya Construction.

| Hasil | Formula |
|---|---|
| Planned minutes per mesin | `Clock` |
| Running minutes | `Σ segmen Running (dibatasi Clock)` |
| Spools produced | spool selesai di mesin selama shift |
| Gross tonnage | `Spools × SpoolWeight / 1000` |
| Good tonnage, Ton FP/SFP | seperti §12.1–12.2 |
| **Availability** (grup) | `(Σ planned − Σ downtime) / Σ planned` |
| **OEE** (grup) | `Availability × Quality` |
| Share | `Good ton grup / Good ton total` |
| Man occupation (grup) | rata-rata Man Occupation operator yang menangani ≥1 mesin di grup |
| Manhour / good ton | `operator terlibat × ShiftHours / Good ton` |
| Status OEE | ≥ 85% World class ✓ · ≥ 65% Typical ! · < 65% Low ✕ |
| Atribut grup | Kolom WL_Products; kosong → diambil dari kode Construction Detail (`Mach-Product-LayLength-TensileGroup-SpoolType-SpoolLength-Speed`) atau spec |

> Report memakai **spool yang selesai di mesin**; card Output di Production Run memakai **spool yang sudah di-doffing** — angka tonase keduanya bisa sedikit berbeda.

---

## 14. Konstanta

| Konstanta | Nilai | Dipakai di |
|---|---|---|
| Waktu tetap per spool | 0.65 menit | Runtime/spool |
| Rata-rata dies per event | 16.5 (`(7 + 26) / 2`) | Forecast, planned dies, estimate |
| Dies per event (engine) | 7 atau 26 (acak) | Engine |
| Peluang backlog awal (Workload) | 30% | Engine Workload |
| Konversi waktu | 2 menit sim per detik nyata di 1× | Kedua simulator |
| Sub-step engine | 0.01 (Workload) · 0.02 (Production) menit | Engine |
| Target Man Occupation default | 85% | Rekomendasi |
| Batas status OEE | 85% / 65% | Report |
| Interval update layar Production | 80 / 150 / 250 ms (≤400 / >400 / >1000 mesin) | Tampilan saja |
