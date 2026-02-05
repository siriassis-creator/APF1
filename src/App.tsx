// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from '@react-google-maps/api';
// @ts-ignore
import * as XLSX from 'xlsx';

const containerStyle = { width: '100%', height: '100vh' };
const center = { lat: 13.7563, lng: 100.5018 };
const routeColors = ["#0088FF", "#FF0000", "#00FF00", "#9900FF", "#FF8800", "#00FFFF", "#FF00FF", "#FFFF00", "#000000", "#888888"];

const VEHICLE_RULES = {
  '4W': { label: '4 ล้อ (BKK Only)', maxKg: 3000, maxDrops: 5, mtdcDropLimit: 3 },
  '6W': { label: '6 ล้อ (POSTO Only)', maxKg: 6000, maxDrops: 3 },
  '10W': { label: '10 ล้อ (POSTO Only)', maxKg: 13000, maxDrops: 3 }
};

const depotIcon = {
  url: "http://googleusercontent.com/maps.google.com/mapfiles/ms/icons/blue-dot.png", 
  scaledSize: { width: 40, height: 40 }
};

function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  var R = 6371; 
  var dLat = (lat2-lat1) * (Math.PI/180);  
  var dLon = (lon2-lon1) * (Math.PI/180); 
  var a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function App() {
  const [allData, setAllData] = useState<any[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [avgKgPerCase, setAvgKgPerCase] = useState<number>(0);
  const [filteredOrders, setFilteredOrders] = useState<any[]>([]);
  const [routeResults, setRouteResults] = useState<any[]>([]); 
  const [leftovers, setLeftovers] = useState<any[]>([]);
  const [depotPos, setDepotPos] = useState<any>(null); 
  const [activeTripId, setActiveTripId] = useState<number | null>(null); 
  const [statusMsg, setStatusMsg] = useState<string>('');
  const [isCalculating, setIsCalculating] = useState<boolean>(false);
  const [isGeocoding, setIsGeocoding] = useState<boolean>(false);

  const { isLoaded } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "", 
    libraries: ['places'] 
  });

  useEffect(() => {
    if (allData.length > 0) {
        const totalKg = allData.reduce((s, row) => s + parseFloat(row['#Kg.'] || 0), 0);
        const totalCs = allData.reduce((s, row) => s + parseFloat(row['#Case'] || 0), 0);
        if (totalCs > 0) setAvgKgPerCase(totalKg / totalCs);
    }
  }, [allData]);

  const handleFileUpload = (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false }) as any[];
      const cleaned = data.map(row => {
        const nr = {};
        Object.keys(row).forEach(k => nr[k.trim()] = row[k]);
        return nr;
      });
      setAvailableDates([...new Set(cleaned.map((item: any) => item['Date']))].filter(d => d));
      setAllData(cleaned);
      if (cleaned.length > 0) handleDateChange(cleaned[0]['Date'], cleaned);
    };
    reader.readAsBinaryString(file);
  };

  const handleDateChange = (date: string, sourceData = allData) => {
    setSelectedDate(date);
    const daily = sourceData.filter((row: any) => row['Date'] === date);
    setFilteredOrders(daily.map((row: any) => ({
      name: row['Ship-to Name'],
      address: `${row['Ship-to Name']} ${row['District']} ${row['Province']}`, 
      province: (row['Province'] || '').trim(),
      channel: (row['Channel'] || '').toUpperCase(),
      weight: parseFloat(row['#Kg.'] || '0'),
      cases: parseFloat(row['#Case'] || '0'),
      lat: null, lng: null
    })));
    setRouteResults([]); setLeftovers([]);
  };

  const geocodeOrders = async () => {
    setIsGeocoding(true);
    const geocoder = new (window as any).google.maps.Geocoder();
    const updated = [...filteredOrders];
    for (let i = 0; i < updated.length; i++) {
        try {
            await new Promise(r => setTimeout(r, 200));
            const res = await geocoder.geocode({ address: updated[i].address });
            if (res.results[0]) {
                updated[i].lat = res.results[0].geometry.location.lat();
                updated[i].lng = res.results[0].geometry.location.lng();
            }
        } catch (e) {}
        setStatusMsg(`ค้นหาพิกัด... ${i+1}/${updated.length}`);
    }
    setFilteredOrders(updated);
    setIsGeocoding(false);
  };

  // Logic ตรวจสอบเงื่อนไขรถ (New Rules)
  const validateVehicle = (orders: any[]) => {
    const totalW = orders.reduce((s, o) => s + o.weight, 0);
    const totalC = orders.reduce((s, o) => s + o.cases, 0);
    const drops = orders.length;
    const isBKK = orders.every(o => o.province === "กรุงเทพมหานคร");
    const isPosto = orders.every(o => o.channel.includes("POSTO"));
    const hasMtdc = orders.some(o => o.channel.includes("MTDC"));

    // Check 4W: BKK Only
    if (isBKK && totalW <= VEHICLE_RULES['4W'].maxKg) {
        const dropLimit = hasMtdc ? VEHICLE_RULES['4W'].mtdcDropLimit : VEHICLE_RULES['4W'].maxDrops;
        const maxCs = Math.floor(VEHICLE_RULES['4W'].maxKg / avgKgPerCase);
        if (drops <= dropLimit && totalC <= maxCs) return '4W';
    }

    // Check 6W: POSTO Only
    if (isPosto && totalW <= VEHICLE_RULES['6W'].maxKg) {
        const maxCs = Math.floor(VEHICLE_RULES['6W'].maxKg / avgKgPerCase);
        if (drops <= VEHICLE_RULES['6W'].maxDrops && totalC <= maxCs) return '6W';
    }

    // Check 10W: POSTO Only
    if (isPosto && totalW <= VEHICLE_RULES['10W'].maxKg) {
        const maxCs = Math.floor(VEHICLE_RULES['10W'].maxKg / avgKgPerCase);
        if (drops <= VEHICLE_RULES['10W'].maxDrops && totalC <= maxCs) return '10W';
    }

    return null;
  };

  async function calculateRoute() {
    setIsCalculating(true);
    let unassigned = [...filteredOrders];
    const trips = [];
    const rejected = [];

    while (unassigned.length > 0) {
        let currentTrip = [];
        let lastPos = depotPos || { lat: 13.75, lng: 100.5 };

        while (unassigned.length > 0) {
            unassigned.sort((a, b) => getDistanceFromLatLonInKm(lastPos.lat, lastPos.lng, a.lat, a.lng) - getDistanceFromLatLonInKm(lastPos.lat, lastPos.lng, b.lat, b.lng));
            const candidate = unassigned[0];
            const testSet = [...currentTrip, candidate];

            const vType = validateVehicle(testSet);
            if (vType) {
                currentTrip.push(unassigned.shift());
                lastPos = { lat: candidate.lat, lng: candidate.lng };
            } else {
                // ถ้าใส่จุดแรกแล้วยังไม่มีรถประเภทไหนรับได้ (เช่น นอก BKK และไม่ใช่ POSTO)
                if (currentTrip.length === 0) rejected.push(unassigned.shift());
                else break;
            }
        }
        if (currentTrip.length > 0) trips.push({ orders: currentTrip, type: validateVehicle(currentTrip) });
    }

    // เรียก API วาดเส้นทาง
    const ds = new (window as any).google.maps.DirectionsService();
    const results = [];
    for (let i = 0; i < trips.length; i++) {
        const res = await ds.route({
            origin: "บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด",
            destination: "บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด",
            waypoints: trips[i].orders.map(o => ({ location: o.address, stopover: true })),
            optimizeWaypoints: true,
            travelMode: 'DRIVING'
        });
        results.push({
            id: i + 1,
            data: res,
            vType: trips[i].type,
            weight: trips[i].orders.reduce((s, o) => s + o.weight, 0),
            cases: trips[i].orders.reduce((s, o) => s + o.cases, 0),
            stops: trips[i].orders.length,
            color: routeColors[i % routeColors.length]
        });
        await new Promise(r => setTimeout(r, 300));
    }
    setRouteResults(results);
    setLeftovers(rejected);
    setIsCalculating(false);
    setStatusMsg(`จัดเสร็จสิ้น! ใช้รถ ${results.length} คัน | ตกค้าง ${rejected.length} รายการ`);
  }

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Sarabun' }}>
      <div style={{ width: '420px', padding: '20px', overflowY: 'auto', borderRight: '1px solid #ddd', backgroundColor: '#f4f7f6' }}>
        <h3>🚚 Delivery Planner (BKK/POSTO Rules)</h3>
        <input type="file" onChange={handleFileUpload} accept=".xlsx" style={{ marginBottom: '15px' }} />
        
        <button onClick={geocodeOrders} disabled={isGeocoding} style={{ width: '100%', padding: '10px', marginBottom: '10px' }}>📍 1. Geocode</button>
        <button onClick={calculateRoute} disabled={isCalculating || filteredOrders.length === 0} style={{ width: '100%', padding: '12px', backgroundColor: '#28a745', color: '#fff', fontWeight: 'bold' }}>🚀 2. Run Optimizer</button>

        <hr/>
        {statusMsg && <div style={{ padding: '10px', backgroundColor: '#fff3cd', borderRadius: '5px', fontSize: '0.85rem' }}>{statusMsg}</div>}

        {/* ส่วนแสดงรายการตกค้าง */}
        {leftovers.length > 0 && (
            <div style={{ marginTop: '15px', padding: '10px', backgroundColor: '#f8d7da', borderRadius: '5px' }}>
                <b style={{ color: '#721c24' }}>⚠️ รายการตกค้าง (จัดไม่ได้ตามเงื่อนไข):</b>
                <ul style={{ fontSize: '0.75rem', paddingLeft: '20px' }}>
                    {leftovers.map((o, idx) => <li key={idx}>{o.name} ({o.province} - {o.channel})</li>)}
                </ul>
            </div>
        )}

        {routeResults.map(trip => (
          <div key={trip.id} onClick={() => setActiveTripId(trip.id)} style={{ padding: '12px', marginTop: '10px', backgroundColor: '#fff', borderLeft: `6px solid ${trip.color}`, cursor: 'pointer', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <b>คันที่ {trip.id}: {trip.vType}</b>
                <span style={{ fontSize: '0.7rem', color: '#666' }}>{trip.stops} Drops</span>
            </div>
            <small>⚖️ {trip.weight.toLocaleString()} kg | 📦 {trip.cases} cs</small>
          </div>
        ))}
      </div>

      <div style={{ flexGrow: 1 }}>
        {isLoaded && (
          <GoogleMap mapContainerStyle={containerStyle} center={center} zoom={10}>
            {routeResults.map(trip => (
              (activeTripId === null || activeTripId === trip.id) && 
              <DirectionsRenderer key={trip.id} directions={trip.data} options={{ polylineOptions: { strokeColor: trip.color, strokeWeight: 6 } }} />
            ))}
          </GoogleMap>
        )}
      </div>
    </div>
  );
}

export default App;