// @ts-nocheck
import React, { useState, useEffect } from 'react';
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from '@react-google-maps/api';
import * as XLSX from 'xlsx';

const containerStyle = { width: '100%', height: '100vh' };
const center = { lat: 13.7563, lng: 100.5018 };
const routeColors = ["#007AFF", "#FF3B30", "#4CD964", "#5856D6", "#FF9500", "#34AADC", "#FF2D55", "#FFCC00", "#8E8E93", "#000000"];

const VEHICLE_SPECS = {
  '4W': { label: '4 ล้อ (3T)', maxKg: 3000, maxDrops: 5, mtdcDropLimit: 3 },
  '6W': { label: '6 ล้อ (6T)', maxKg: 6000, maxDrops: 3 },
  '10W': { label: '10 ล้อ (13T)', maxKg: 13000, maxDrops: 3 }
};

function getDist(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371; 
  const dLat = (lat2-lat1) * (Math.PI/180);  
  const dLon = (lon2-lon1) * (Math.PI/180); 
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function App() {
  const [allData, setAllData] = useState<any[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  const [originAddress, setOriginAddress] = useState<string>('บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด');
  const [isRoundTrip, setIsRoundTrip] = useState<boolean>(true);
  
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
      const dates = [...new Set(cleaned.map((item: any) => item['Date']))].filter(d => d);
      setAvailableDates(dates);
      setAllData(cleaned);
      if (dates.length > 0) handleDateChange(dates[0], cleaned);
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
    setRouteResults([]); setLeftovers([]); setStatusMsg('');
  };

  const geocodeOrders = async () => {
    setIsGeocoding(true);
    const geocoder = new (window as any).google.maps.Geocoder();
    const updated = [...filteredOrders];
    const dRes = await geocoder.geocode({ address: originAddress });
    if (dRes.results[0]) setDepotPos({ lat: dRes.results[0].geometry.location.lat(), lng: dRes.results[0].geometry.location.lng() });

    for (let i = 0; i < updated.length; i++) {
        if (updated[i].lat) continue;
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

  const determineVehicle = (orders: any[]) => {
    const totalW = orders.reduce((s, o) => s + o.weight, 0);
    const drops = orders.length;
    const isPosto = orders.every(o => o.channel.includes("POSTO"));
    const hasMtdc = orders.some(o => o.channel.includes("MTDC"));

    // Check 10W (Posto Only)
    if (isPosto && totalW <= VEHICLE_SPECS['10W'].maxKg && drops <= VEHICLE_SPECS['10W'].maxDrops) {
        if (totalW > 6000) return '10W';
    }
    // Check 6W (Posto Only)
    if (isPosto && totalW <= VEHICLE_SPECS['6W'].maxKg && drops <= VEHICLE_SPECS['6W'].maxDrops) {
        if (totalW > 3000) return '6W';
    }
    // Check 4W (Any Channel)
    if (totalW <= VEHICLE_SPECS['4W'].maxKg) {
        const limit = hasMtdc ? VEHICLE_SPECS['4W'].mtdcDropLimit : VEHICLE_SPECS['4W'].maxDrops;
        if (drops <= limit) return '4W';
    }
    return null;
  };

  async function calculateRoute() {
    setIsCalculating(true);
    let unassigned = [...filteredOrders.filter(o => o.lat !== null)];
    const trips = [];
    const rejected = [];

    while (unassigned.length > 0) {
        let currentTrip = [];
        let lastPos = depotPos || center;

        while (unassigned.length > 0) {
            unassigned.sort((a, b) => getDist(lastPos.lat, lastPos.lng, a.lat, a.lng) - getDist(lastPos.lat, lastPos.lng, b.lat, b.lng));
            const candidate = unassigned[0];
            const testSet = [...currentTrip, candidate];

            const vType = determineVehicle(testSet);
            if (vType) {
                currentTrip.push(unassigned.shift());
                lastPos = { lat: candidate.lat, lng: candidate.lng };
            } else {
                if (currentTrip.length === 0) rejected.push(unassigned.shift());
                else break;
            }
        }
        if (currentTrip.length > 0) trips.push({ orders: currentTrip, type: determineVehicle(currentTrip) });
    }

    const ds = new (window as any).google.maps.DirectionsService();
    const results = [];
    for (let i = 0; i < trips.length; i++) {
        const trip = trips[i];
        const res = await ds.route({
            origin: originAddress,
            destination: isRoundTrip ? originAddress : trip.orders[trip.orders.length-1].address,
            waypoints: isRoundTrip ? trip.orders.map(o => ({ location: o.address, stopover: true })) : trip.orders.slice(0,-1).map(o => ({ location: o.address, stopover: true })),
            optimizeWaypoints: true,
            travelMode: 'DRIVING'
        });

        const totalW = trip.orders.reduce((s, o) => s + o.weight, 0);
        const loadP = (totalW / VEHICLE_SPECS[trip.type].maxKg) * 100;

        results.push({
            id: i + 1,
            data: res,
            vType: trip.type,
            vLabel: VEHICLE_SPECS[trip.type].label,
            weight: totalW,
            cases: trip.orders.reduce((s, o) => s + o.cases, 0),
            loadFactor: loadP.toFixed(1),
            color: routeColors[i % routeColors.length],
            stops: trip.orders.length,
            legs: res.routes[0].legs,
            orderedStops: res.routes[0].waypoint_order.map(idx => trip.orders[idx])
        });
        await new Promise(r => setTimeout(r, 400));
    }
    setRouteResults(results);
    setLeftovers(rejected);
    setIsCalculating(false);
    setStatusMsg(`จัดสำเร็จ ${results.length} คัน | ตกค้าง ${rejected.length}`);
  }

  const exportToExcel = () => {
    const report = [];
    routeResults.forEach(trip => {
        trip.orderedStops.forEach((stop, idx) => {
            report.push({
                'Trip ID': trip.id,
                'Vehicle Type': trip.vLabel,
                'Seq': idx + 1,
                'Customer': stop.name,
                'Address': stop.address,
                'Channel': stop.channel,
                'Weight (Kg)': stop.weight,
                'Cases': stop.cases,
                'Trip Load (%)': trip.loadFactor
            });
        });
    });
    const ws = XLSX.utils.json_to_sheet(report);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Delivery_Plan");
    XLSX.writeFile(wb, `Delivery_Plan_${selectedDate}.xlsx`);
  };

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'Sarabun, sans-serif' }}>
      <div style={{ width: '400px', padding: '20px', overflowY: 'auto', borderRight: '1px solid #ddd', backgroundColor: '#f8f9fa' }}>
        <h3 style={{ margin: '0 0 15px 0' }}>🚛 Smart Dispatcher</h3>
        
        <div style={{ background: '#fff', padding: '15px', borderRadius: '8px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', marginBottom: '15px' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 'bold' }}>📂 อัปโหลดไฟล์</label>
            <input type="file" onChange={handleFileUpload} accept=".xlsx" style={{ width: '100%', marginTop: '5px' }} />
            
            <div style={{ marginTop: '10px' }}>
                <label style={{ fontSize: '0.8rem' }}>🏠 จุดเริ่มต้น</label>
                <input type="text" value={originAddress} onChange={e => setOriginAddress(e.target.value)} style={{ width: '100%', padding: '5px' }} />
            </div>

            <div style={{ marginTop: '10px' }}>
                <label style={{ fontSize: '0.85rem' }}>
                    <input type="checkbox" checked={isRoundTrip} onChange={e => setIsRoundTrip(e.target.checked)} /> Round Trip
                </label>
                <select value={selectedDate} onChange={e => handleDateChange(e.target.value)} style={{ width: '100%', marginTop: '5px', padding: '5px' }}>
                    {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
                </select>
            </div>
        </div>

        <button onClick={geocodeOrders} disabled={isGeocoding} style={{ width: '100%', padding: '10px', marginBottom: '8px' }}>📍 1. ค้นหาพิกัด</button>
        <button onClick={calculateRoute} disabled={isCalculating || filteredOrders.length === 0} style={{ width: '100%', padding: '10px', backgroundColor: '#007AFF', color: '#fff', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer', marginBottom: '8px' }}>🚀 2. จัดเส้นทาง</button>
        
        {routeResults.length > 0 && (
            <button onClick={exportToExcel} style={{ width: '100%', padding: '10px', backgroundColor: '#28a745', color: '#fff', border: 'none', borderRadius: '5px', fontWeight: 'bold', cursor: 'pointer' }}>📊 3. Export to Excel</button>
        )}

        <div style={{ marginTop: '15px', fontSize: '0.85rem', color: '#27ae60' }}>{statusMsg}</div>

        {leftovers.length > 0 && <div style={{ color: 'red', fontSize: '0.75rem', marginTop: '10px' }}>⚠️ ตกค้าง {leftovers.length} รายการ (ไม่เข้าเงื่อนไขรถ)</div>}

        {routeResults.map(trip => (
          <div key={trip.id} onClick={() => setActiveTripId(trip.id)} style={{ padding: '12px', marginTop: '12px', backgroundColor: '#fff', borderLeft: `6px solid ${trip.color}`, cursor: 'pointer', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <b>คันที่ {trip.id}: {trip.vType}</b>
                <span style={{ fontSize: '0.7rem', padding: '2px 5px', borderRadius: '5px', background: parseFloat(trip.loadFactor) >= 90 ? '#d4edda' : '#eee', color: parseFloat(trip.loadFactor) >= 90 ? '#155724' : '#333' }}>
                    {trip.loadFactor}%
                </span>
            </div>
            <div style={{ fontSize: '0.8rem', color: '#666' }}>⚖️ {trip.weight.toLocaleString()} kg | 📍 {trip.stops} Drop</div>
          </div>
        ))}
      </div>

      <div style={{ flexGrow: 1 }}>
        {isLoaded && (
          <GoogleMap mapContainerStyle={containerStyle} center={depotPos || center} zoom={11}>
            {depotPos && <MarkerF position={depotPos} />}
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