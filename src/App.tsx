// @ts-nocheck
import React, { useState, useRef } from 'react';
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF, InfoWindowF } from '@react-google-maps/api';
import * as XLSX from 'xlsx';

// --- Constants ---
const VEHICLE_SPECS = {
  '4W': { label: '4 ล้อ (3T)', maxKg: 3000, maxDrops: 5, mtdcDropLimit: 3 },
  '6W': { label: '6 ล้อ (6T)', maxKg: 6000, maxDrops: 3, minEffKg: 4800 },
  '10W': { label: '10 ล้อ (13T)', maxKg: 13000, maxDrops: 3 }
};
const routeColors = ["#6366f1", "#ef4444", "#10b981", "#f59e0b", "#06b6d4", "#8b5cf6", "#ec4899", "#71717a"];
const getLetter = (index) => String.fromCharCode(65 + index);

const containerStyle = { width: '100%', height: '100%' };

const depotIcon = {
  path: "M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z",
  fillColor: "#1e293b", fillOpacity: 1, strokeWeight: 1, strokeColor: "#ffffff", scale: 1.5, anchor: { x: 12, y: 12 }
};

// --- Helpers ---

function excelDateToJSDate(serial) {
   if (!serial) return "";
   if (typeof serial === 'string') return serial;
   const utc_days  = Math.floor(serial - 25569);
   const utc_value = utc_days * 86400;                                        
   const date_info = new Date(utc_value * 1000);
   const day = date_info.getDate().toString().padStart(2, '0');
   const month = (date_info.getMonth() + 1).toString().padStart(2, '0');
   const year = date_info.getFullYear();
   return `${day}/${month}/${year}`;
}

// แปลงเวลา Excel/String เป็นนาที
function parseExcelTime(val) {
    if (val === undefined || val === null || val === "") return null;
    if (typeof val === 'number') {
        return Math.round(val * 24 * 60);
    }
    if (typeof val === 'string') {
        const parts = val.split(':');
        if (parts.length >= 2) {
            const h = parseInt(parts[0], 10);
            const m = parseInt(parts[1], 10);
            return (h * 60) + m;
        }
    }
    return null;
}

// แปลงนาทีกลับเป็นข้อความ HH:MM
function minutesToTimeStr(totalMinutes) {
    if (totalMinutes === null || totalMinutes === undefined) return "";
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

function getDist(lat1, lon1, lat2, lon2) {
  const R = 6371; 
  const dLat = (lat2-lat1) * (Math.PI/180);  
  const dLon = (lon2-lon1) * (Math.PI/180); 
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * (Math.PI/180)) * Math.cos(lat2 * (Math.PI/180)) * Math.sin(dLon/2) * Math.sin(dLon/2); 
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function App() {
  const [allData, setAllData] = useState([]);
  const [rawData, setRawData] = useState([]); // เก็บ Raw Data ไว้ export
  const [availableDates, setAvailableDates] = useState([]);
  const [selectedDate, setSelectedDate] = useState('');
  const [originAddress, setOriginAddress] = useState('บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด');
  const [isRoundTrip, setIsRoundTrip] = useState(true);
  const [useLatLongFromExcel, setUseLatLongFromExcel] = useState(false);
  
  const [filteredOrders, setFilteredOrders] = useState([]);
  const [routeResults, setRouteResults] = useState([]);
  const [leftovers, setLeftovers] = useState([]);
  const [depotPos, setDepotPos] = useState(null);
  const [activeTripId, setActiveTripId] = useState(null);
  const [statusMsg, setStatusMsg] = useState('');
  const [isCalculating, setIsCalculating] = useState(false);
  const [isGeocoding, setIsGeocoding] = useState(false);

  const fileInputRef = useRef(null);

  const { isLoaded } = useJsApiLoader({
    id: 'google-map-script',
    googleMapsApiKey: "AIzaSyA1xq72aZlW3-opcXu8M6DDM-6FodaKKCU",
    libraries: ['places']
  });

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      const bstr = evt.target?.result;
      const wb = XLSX.read(bstr, { type: 'binary' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      
      if (data.length <= 1) {
          alert("ไม่พบข้อมูลในไฟล์");
          return;
      }

      // 1. เก็บ Raw Data ไว้ (ทั้งก้อน)
      setRawData(data);

      // 2. Process Data สำหรับ App
      const cleaned = data.slice(1).map(row => {
        return {
            date: excelDateToJSDate(row[0]), 
            name: row[2] || '',           
            subDistrict: row[3] || '',    
            district: row[4] || '',       
            province: row[5] || '',       
            postcode: row[6] || '',       
            lat: parseFloat(row[7] || 0), 
            lng: parseFloat(row[8] || 0), 
            channel: (row[10] || '').toUpperCase(), 
            cases: parseFloat(row[11] || 0),        
            weight: parseFloat(row[12] || 0),
            
            // New Columns
            timeStart: parseExcelTime(row[13]), 
            timeEnd: parseExcelTime(row[14]),   
            street1: row[15] || '',             
            street2: row[16] || '',             
            
            originalLat: parseFloat(row[7] || 0),
            originalLng: parseFloat(row[8] || 0)
        };
      }).filter(item => item.name);

      const dates = [...new Set(cleaned.map(item => item.date))].filter(d => d);
      setAvailableDates(dates);
      setAllData(cleaned);
      if (dates.length > 0) handleDateChange(dates[0], cleaned);
      else handleDateChange('', cleaned);
    };
    reader.readAsBinaryString(file);
  };

  const handleDateChange = (date, sourceData = allData) => {
    setSelectedDate(date);
    const daily = date ? sourceData.filter(row => row.date === date) : sourceData;
    
    const orders = daily.map(row => {
        const parts = [
            row.name,
            row.street1,
            row.street2,
            row.subDistrict,
            row.district,
            row.province,
            row.postcode
        ].filter(p => p && String(p).trim() !== "");

        let timeStr = "";
        if (row.timeStart !== null) {
            timeStr = `${minutesToTimeStr(row.timeStart)} - ${minutesToTimeStr(row.timeEnd)}`;
        }

        return {
            ...row,
            addressSearchQuery: parts.join(" "),
            displayAddress: `${row.street1} ${row.street2} ${row.district}`.trim() || `${row.district} ${row.province}`,
            timeWindowText: timeStr,
            lat: null, 
            lng: null
        };
    });

    setFilteredOrders(orders);
    setRouteResults([]); setLeftovers([]); setStatusMsg('');
  };

  const handleClearData = () => {
    if(window.confirm('ต้องการล้างข้อมูลทั้งหมด?')) {
        setAllData([]);
        setRawData([]);
        setAvailableDates([]);
        setSelectedDate('');
        setFilteredOrders([]);
        setRouteResults([]);
        setLeftovers([]);
        setDepotPos(null);
        setActiveTripId(null);
        setStatusMsg('');
        if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const geocodeOrders = async () => {
    setIsGeocoding(true);
    const geocoder = new window.google.maps.Geocoder();
    const updated = [...filteredOrders];
    
    try {
        const dRes = await geocoder.geocode({ address: originAddress });
        if (dRes.results[0]) setDepotPos({ lat: dRes.results[0].geometry.location.lat(), lng: dRes.results[0].geometry.location.lng() });
    } catch(e) {}

    for (let i = 0; i < updated.length; i++) {
      let foundLat = null;
      let foundLng = null;

      if (useLatLongFromExcel && updated[i].originalLat && updated[i].originalLng) {
          foundLat = updated[i].originalLat;
          foundLng = updated[i].originalLng;
      }

      if (!foundLat) {
          if (updated[i].lat && updated[i].lng) {
              foundLat = updated[i].lat;
              foundLng = updated[i].lng;
          } else {
              try {
                await new Promise(r => setTimeout(r, 250));
                const res = await geocoder.geocode({ address: updated[i].addressSearchQuery });
                if (res.results[0]) {
                  foundLat = res.results[0].geometry.location.lat();
                  foundLng = res.results[0].geometry.location.lng();
                }
              } catch (e) { console.warn(`Geocode failed: ${updated[i].name}`); }
          }
      }

      if (foundLat && foundLng) {
          updated[i].lat = foundLat;
          updated[i].lng = foundLng;
      }
      
      setStatusMsg(`📍 ประมวลผลพิกัด... ${i + 1}/${updated.length}`);
    }
    
    setFilteredOrders(updated);
    setIsGeocoding(false);
    setStatusMsg(`✅ พร้อมจัดเส้นทาง (${updated.filter(o => o.lat).length} จุด)`);
  };

  const determineVehicle = (orders) => {
    const totalW = orders.reduce((s, o) => s + o.weight, 0);
    const drops = orders.length;
    const isPosto = orders.every(o => o.channel.includes("POSTO"));
    const hasMtdc = orders.some(o => o.channel.includes("MTDC"));

    if (isPosto && totalW <= 13000 && drops <= 3 && totalW > 6000) return '10W';
    if (totalW >= 4800 && totalW <= 6000 && drops <= 3) return '6W'; 
    if (totalW <= 3000) {
      const limit = hasMtdc ? 3 : 5;
      if (drops <= limit) return '4W';
    }
    return null;
  };

  async function calculateRoute() {
    setIsCalculating(true);
    setStatusMsg('⏳ กำลังคำนวณเส้นทาง...');
    setRouteResults([]);
    await new Promise(r => setTimeout(r, 100));

    let unassigned = [...filteredOrders.filter(o => o.lat !== null)];
    
    // Sort เบื้องต้น: เวลาเริ่ม -> ระยะทาง
    unassigned.sort((a, b) => {
        const tA = a.timeStart !== null ? a.timeStart : 9999;
        const tB = b.timeStart !== null ? b.timeStart : 9999;
        return tA - tB;
    });

    const trips = [];
    const rejected = [];

    while (unassigned.length > 0) {
      let currentTrip = [];
      let lastPos = depotPos || { lat: 13.7563, lng: 100.5018 };

      while (unassigned.length > 0) {
        unassigned.sort((a, b) => {
            const distA = getDist(lastPos.lat, lastPos.lng, a.lat, a.lng);
            const distB = getDist(lastPos.lat, lastPos.lng, b.lat, b.lng);
            const tA = a.timeStart !== null ? a.timeStart : 9999;
            const tB = b.timeStart !== null ? b.timeStart : 9999;
            const timeDiff = tA - tB;
            
            if (timeDiff < -60) return -1;
            if (timeDiff > 60) return 1;
            return distA - distB;
        });

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

    const ds = new window.google.maps.DirectionsService();
    const finalResults = [];

    for (let i = 0; i < trips.length; i++) {
      const trip = trips[i];
      const waypoints = trip.orders.map(o => ({ location: { lat: o.lat, lng: o.lng }, stopover: true }));
      let destination, apiWaypoints;

      if (isRoundTrip) {
          destination = originAddress; 
          apiWaypoints = waypoints; 
      } else {
          destination = { lat: trip.orders[trip.orders.length - 1].lat, lng: trip.orders[trip.orders.length - 1].lng };
          apiWaypoints = waypoints.slice(0, -1);
      }

      try {
        const res = await ds.route({
          origin: originAddress,
          destination: destination,
          waypoints: apiWaypoints,
          optimizeWaypoints: true,
          travelMode: 'DRIVING'
        });

        const totalW = trip.orders.reduce((s, o) => s + o.weight, 0);
        const route = res.routes[0];
        const wOrder = route.waypoint_order;

        let totalDistMeters = 0;
        route.legs.forEach(leg => totalDistMeters += leg.distance.value);
        const totalDistKm = (totalDistMeters / 1000).toFixed(1);

        let orderedStops = [];
        if (isRoundTrip) {
            orderedStops = wOrder.map(idx => trip.orders[idx]);
        } else {
            const middleStops = trip.orders.slice(0, -1);
            const sortedMiddle = wOrder.map(idx => middleStops[idx]);
            orderedStops = [...sortedMiddle, trip.orders[trip.orders.length - 1]];
        }

        finalResults.push({
          id: i + 1,
          data: res,
          vType: trip.type,
          vLabel: VEHICLE_SPECS[trip.type].label,
          weight: totalW,
          cases: trip.orders.reduce((s, o) => s + o.cases, 0),
          loadFactor: ((totalW / VEHICLE_SPECS[trip.type].maxKg) * 100).toFixed(1),
          totalDist: totalDistKm,
          color: routeColors[i % routeColors.length],
          stops: trip.orders.length,
          legs: route.legs,
          orderedStops: orderedStops 
        });
      } catch (err) { console.error(err); }
      
      setStatusMsg(`กำลังจัด... ${i + 1}/${trips.length} คัน`);
      await new Promise(r => setTimeout(r, 350));
    }

    setRouteResults(finalResults);
    setLeftovers(rejected);
    setIsCalculating(false);
    setStatusMsg(`🎉 จัดสำเร็จ ${finalResults.length} คัน`);
  }

  const calculateSummary = () => {
    const total = filteredOrders.reduce((acc, o) => ({ 
        count: acc.count + 1, 
        weight: acc.weight + o.weight,
        cases: acc.cases + o.cases
    }), { count: 0, weight: 0, cases: 0 });

    const planned = routeResults.reduce((acc, trip) => ({
        count: acc.count + trip.stops,
        weight: acc.weight + trip.weight,
        cases: acc.cases + trip.cases
    }), { count: 0, weight: 0, cases: 0 });

    const leftover = leftovers.reduce((acc, o) => ({
        count: acc.count + 1,
        weight: acc.weight + o.weight,
        cases: acc.cases + o.cases
    }), { count: 0, weight: 0, cases: 0 });

    return { total, planned, leftover };
  };

  const summary = calculateSummary();

  // --- Export Logic Adjusted ---
  const exportToExcel = () => {
    const wb = XLSX.utils.book_new();

    // Sheet 1: Delivery Plan
    const planReport = [];
    routeResults.forEach(trip => {
      trip.orderedStops.forEach((stop, idx) => {
        planReport.push({
          'Trip ID': trip.id,
          'Vehicle Type': trip.vLabel,
          'Seq': idx + 1,
          'Customer': stop.name,
          'Time Window': stop.timeWindowText,
          'District': stop.district,
          'Province': stop.province,
          'Weight (Kg)': stop.weight,
          'Cases': stop.cases,
          'Trip Load (%)': trip.loadFactor,
          'Trip Distance (Km)': trip.totalDist
        });
      });
    });
    const wsPlan = XLSX.utils.json_to_sheet(planReport);
    XLSX.utils.book_append_sheet(wb, wsPlan, "Delivery_Plan");

    // Sheet 2: Leftover
    const leftoverReport = leftovers.map((stop, idx) => ({
        'Seq': idx + 1,
        'Customer': stop.name,
        'Time Window': stop.timeWindowText,
        'District': stop.district,
        'Province': stop.province,
        'Weight (Kg)': stop.weight,
        'Cases': stop.cases,
        'Status': 'Leftover / Unplanned'
    }));
    const wsLeftover = XLSX.utils.json_to_sheet(leftoverReport);
    XLSX.utils.book_append_sheet(wb, wsLeftover, "Leftover");

    // Sheet 3: Original (Filtered by Date)
    if (rawData.length > 0) {
        const header = rawData[0]; // เก็บ Header ไว้
        // กรองเอาเฉพาะข้อมูลที่มีวันที่ตรงกับ selectedDate
        const filteredRawRows = rawData.slice(1).filter(row => {
            const rowDateStr = excelDateToJSDate(row[0]);
            return rowDateStr === selectedDate;
        });
        
        // รวม Header กลับเข้าไป
        const finalOriginalData = [header, ...filteredRawRows];
        const wsOriginal = XLSX.utils.aoa_to_sheet(finalOriginalData);
        XLSX.utils.book_append_sheet(wb, wsOriginal, "Original");
    }

    XLSX.writeFile(wb, `Delivery_Plan_${selectedDate}.xlsx`);
  };

  if (!isLoaded) return <div style={{height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center'}}>Loading App...</div>;

  return (
    <div className="app-container">
      <aside className="sidebar">
        <header className="sidebar-header">
          <div className="logo-area">
            <span className="logo-icon">🚚</span>
            <span className="logo-text">Dispatcher Pro</span>
          </div>
        </header>

        <div className="sidebar-scroll">
          <div className="control-panel">
            <div className="input-group">
                <label>📂 อัปโหลดไฟล์</label>
                <input 
                    type="file" 
                    onChange={handleFileUpload} 
                    accept=".xlsx" 
                    className="file-input" 
                    ref={fileInputRef} 
                />
            </div>
            
            {allData.length > 0 && (
            <>
                <div className="input-group">
                    <label>🏠 จุดเริ่มต้น</label>
                    <input type="text" value={originAddress} onChange={e => setOriginAddress(e.target.value)} />
                </div>
                
                {/* Options Group */}
                <div className="options-box">
                    <div className="options-title">⚙️ Options</div>
                    <div className="input-group">
                        <label>📅 วันที่ขนส่ง</label>
                        <select value={selectedDate} onChange={e => handleDateChange(e.target.value)}>
                            {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
                        </select>
                    </div>
                    <label className="checkbox-row">
                        <input type="checkbox" checked={isRoundTrip} onChange={e => setIsRoundTrip(e.target.checked)} />
                        <span>วิ่งงานไป-กลับ (Round Trip)</span>
                    </label>
                    <label className="checkbox-row">
                        <input type="checkbox" checked={useLatLongFromExcel} onChange={e => setUseLatLongFromExcel(e.target.checked)} />
                        <span>ใช้พิกัดจากไฟล์ Excel (Lat/Long)</span>
                    </label>
                </div>

                <div className="action-buttons">
                    <button className="btn-secondary" onClick={geocodeOrders} disabled={isGeocoding}>
                        {isGeocoding ? '📍 กำลังหา...' : '📍 ค้นหาพิกัด'}
                    </button>
                    <button 
                        className={`btn-primary ${isCalculating ? 'loading' : ''}`} 
                        onClick={calculateRoute} 
                        disabled={isCalculating || filteredOrders.length === 0}
                    >
                        {isCalculating && <div className="spinner-mini"></div>}
                        {isCalculating ? 'กำลังคำนวณ...' : '🚀 เริ่มจัดเส้นทาง'}
                    </button>
                </div>
                
                <button className="btn-clear-full" onClick={handleClearData}>
                    🗑️ ล้างข้อมูลทั้งหมด
                </button>
            </>
            )}
          </div>

          <div className="status-bar">{statusMsg}</div>

          {/* Summary Dashboard */}
          {allData.length > 0 && (
            <div className="summary-dashboard">
                <div className="summary-col">
                    <div className="sum-label">ทั้งหมด</div>
                    <div className="sum-val">{summary.total.count} จุด</div>
                    <div className="sum-sub">{summary.total.weight.toLocaleString()} kg</div>
                </div>
                <div className="summary-col planned">
                    <div className="sum-label">จัดได้</div>
                    <div className="sum-val">{summary.planned.count} จุด</div>
                    <div className="sum-sub">{summary.planned.weight.toLocaleString()} kg</div>
                </div>
                <div className="summary-col leftover">
                    <div className="sum-label">ตกค้าง</div>
                    <div className="sum-val">{summary.leftover.count} จุด</div>
                    <div className="sum-sub">{summary.leftover.weight.toLocaleString()} kg</div>
                </div>
            </div>
          )}

          {leftovers.length > 0 && (
            <div className="leftover-card">
              <h4>⚠️ รายการตกค้าง ({leftovers.length})</h4>
              <div className="leftover-list">
                {leftovers.map((item, i) => (
                  <div key={i} className="leftover-item">
                    <b>{item.name}</b> <br/> {item.weight} kg
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="trip-list">
            {routeResults.length > 0 && (
                <div className="trip-list-header">
                    <h3>ผลลัพธ์: {routeResults.length} คัน</h3>
                    <button className="btn-export" onClick={exportToExcel}>📥 Excel</button>
                </div>
            )}
            
            {routeResults.map(trip => (
              <div 
                key={trip.id} 
                className={`trip-card ${activeTripId === trip.id ? 'active' : ''}`}
                onClick={() => setActiveTripId(activeTripId === trip.id ? null : trip.id)}
                style={{ borderLeftColor: trip.color }}
              >
                <div className="trip-header">
                  <div>
                    <span className="badge" style={{backgroundColor: trip.color}}>TRIP {trip.id}</span>
                    <span className="v-label">{trip.vLabel}</span>
                  </div>
                  <span className={`load-pct ${parseFloat(trip.loadFactor) >= 80 ? 'good' : 'low'}`}>{trip.loadFactor}%</span>
                </div>
                
                <div className="trip-metrics">
                  <span>⚖️ {trip.weight.toLocaleString()} kg</span>
                  <span>📍 {trip.stops} จุด</span>
                  <span>🛣️ {trip.totalDist} km</span>
                </div>

                {activeTripId === trip.id && (
                  <div className="trip-details">
                    {trip.orderedStops.map((stop, idx) => {
                      const letter = getLetter(idx);
                      const leg = trip.legs[idx]; 
                      
                      return (
                        <div key={idx} className="stop-item">
                          <div className="stop-marker" style={{background: trip.color}}>
                             {letter}
                          </div>
                          <div className="stop-info">
                            <div className="stop-name">{stop.name}</div>
                            {stop.timeWindowText && (
                                <div className="stop-time">🕒 {stop.timeWindowText}</div>
                            )}
                            <div className="stop-addr">{stop.displayAddress || stop.district + ' ' + stop.province}</div>
                            <div className="stop-detail">📦 {stop.cases} cs | ⚖️ {stop.weight} kg</div>
                            {leg && <div className="stop-meta">🚩 {leg.distance.text} • 🕒 {leg.duration.text}</div>}
                          </div>
                        </div>
                      );
                    })}
                    {isRoundTrip && (
                        <div className="stop-item" style={{opacity: 0.7}}>
                            <div className="stop-marker" style={{background: '#94a3b8'}}>🏁</div>
                            <div className="stop-info"><div className="stop-name">กลับจุดเริ่มต้น</div></div>
                        </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="map-wrapper">
        <GoogleMap 
          mapContainerStyle={containerStyle} 
          center={depotPos || { lat: 13.7563, lng: 100.5018 }} 
          zoom={11}
          options={{ disableDefaultUI: false, zoomControl: true }}
        >
          {depotPos && <MarkerF position={depotPos} icon={depotIcon} />}
          
          {routeResults.map(trip => (
            (activeTripId === null || activeTripId === trip.id) && 
            <DirectionsRenderer 
              key={trip.id} 
              directions={trip.data} 
              options={{ 
                polylineOptions: { strokeColor: trip.color, strokeWeight: 5, strokeOpacity: 0.8 },
                suppressMarkers: true,
                preserveViewport: true
              }} 
            />
          ))}
          
          {activeTripId !== null && routeResults.find(t => t.id === activeTripId)?.orderedStops.map((stop, i) => (
             <React.Fragment key={i}>
                 <MarkerF 
                    position={{ lat: stop.lat, lng: stop.lng }} 
                    label={{ text: getLetter(i), color: "white", fontWeight: "bold" }}
                 />
                 <InfoWindowF
                    position={{ lat: stop.lat, lng: stop.lng }}
                    options={{ 
                        disableAutoPan: true, 
                        closeBoxURL: "", 
                        pixelOffset: new window.google.maps.Size(0, -40),
                        zIndex: 0
                    }}
                 >
                    <div style={{
                        padding: '4px 8px', 
                        borderRadius: '4px',
                        backgroundColor: 'white',
                        border: '1px solid #ccc',
                        color: '#333',
                        boxShadow: '0 2px 6px rgba(0,0,0,0.2)',
                        minWidth: '130px'
                    }}>
                        <div style={{ fontWeight: 'bold', fontSize: '11px', marginBottom: '2px' }}>{stop.name}</div>
                        {stop.timeWindowText && (
                            <div style={{ fontSize: '10px', color: '#dc2626', fontWeight: 'bold' }}>🕒 {stop.timeWindowText}</div>
                        )}
                        <div style={{ fontSize: '10px', color: '#666' }}>{stop.displayAddress || stop.district}</div>
                    </div>
                 </InfoWindowF>
             </React.Fragment>
          ))}
        </GoogleMap>
      </main>

      <style>{`
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body, html, #root { width: 100%; height: 100%; font-family: 'Sarabun', sans-serif; overflow: hidden; background: #f8fafc; }
        .app-container { display: flex; width: 100vw; height: 100vh; }
        .sidebar { width: 400px; min-width: 400px; background: white; display: flex; flex-direction: column; border-right: 1px solid #e2e8f0; z-index: 20; box-shadow: 4px 0 16px rgba(0,0,0,0.05); text-align: left; }
        .sidebar-header { padding: 15px 20px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; background: #fff; height: 60px; }
        .logo-area { display: flex; align-items: center; gap: 10px; }
        .logo-icon { font-size: 1.5rem; }
        .logo-text { font-size: 1rem; font-weight: 800; color: #1e293b; white-space: nowrap; }
        .sidebar-scroll { flex: 1; overflow-y: auto; padding: 20px; }
        .control-panel { background: #f8fafc; padding: 15px; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 15px; }
        .input-group { margin-bottom: 12px; }
        .input-group label { display: block; font-size: 0.75rem; font-weight: 700; color: #64748b; margin-bottom: 5px; text-transform: uppercase; }
        .input-group input[type="text"], .input-group select { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 0.9rem; outline: none; }
        .input-group input[type="text"]:focus { border-color: #6366f1; }
        .file-input { font-size: 0.85rem; width: 100%; }
        
        .options-box { background: white; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; margin-bottom: 15px; }
        .options-title { font-size: 0.8rem; font-weight: 700; color: #334155; margin-bottom: 10px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
        
        .checkbox-row { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; padding-bottom: 8px; cursor: pointer; color: #334155; }
        
        .action-buttons { display: grid; grid-template-columns: 1fr 1.5fr; gap: 10px; margin-top: 10px; }
        .btn-secondary { background: white; border: 1px solid #cbd5e1; color: #334155; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; }
        .btn-primary { background: #4f46e5; color: white; border: none; padding: 10px; border-radius: 8px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center; gap: 8px; transition: 0.2s; }
        .btn-primary:hover { background: #4338ca; box-shadow: 0 4px 12px rgba(79, 70, 229, 0.3); }
        .btn-primary:disabled { opacity: 0.7; cursor: not-allowed; }
        .btn-primary.loading { background: #6366f1; cursor: wait; }
        
        .btn-clear-full { width: 100%; margin-top: 10px; background: #fee2e2; color: #dc2626; border: 1px dashed #fca5a5; padding: 8px; border-radius: 8px; font-size: 0.8rem; font-weight: 600; cursor: pointer; transition: 0.2s; }
        .btn-clear-full:hover { background: #fecaca; }
        
        .status-bar { text-align: center; font-size: 0.85rem; color: #10b981; font-weight: 600; margin-bottom: 15px; min-height: 20px; }
        
        /* Summary Dashboard */
        .summary-dashboard { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 20px; }
        .summary-col { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 5px; text-align: center; }
        .summary-col.planned { border-color: #86efac; background: #f0fdf4; }
        .summary-col.leftover { border-color: #fca5a5; background: #fef2f2; }
        
        .sum-label { font-size: 0.65rem; color: #64748b; font-weight: 700; text-transform: uppercase; }
        .sum-val { font-size: 0.9rem; font-weight: 800; color: #1e293b; margin: 2px 0; }
        .sum-sub { font-size: 0.65rem; color: #94a3b8; }

        .leftover-card { background: #fff1f2; border: 1px solid #fecdd3; padding: 12px; border-radius: 8px; margin-bottom: 20px; }
        .leftover-card h4 { color: #be123c; font-size: 0.85rem; margin-bottom: 8px; }
        .leftover-list { max-height: 100px; overflow-y: auto; }
        .leftover-item { font-size: 0.75rem; color: #881337; padding: 4px 0; border-bottom: 1px solid #ffe4e6; }
        
        .trip-list-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .trip-list-header h3 { font-size: 0.95rem; color: #334155; }
        .btn-export { background: #10b981; color: white; border: none; padding: 6px 12px; border-radius: 6px; font-size: 0.75rem; font-weight: 600; cursor: pointer; }
        
        .trip-card { background: white; border: 1px solid #e2e8f0; border-left: 4px solid #ccc; border-radius: 10px; padding: 16px; margin-bottom: 12px; cursor: pointer; transition: all 0.2s; position: relative; }
        .trip-card:hover { transform: translateY(-2px); box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); }
        .trip-card.active { border-color: #6366f1; background: #f8fafc; }
        
        .trip-header { display: flex; justify-content: space-between; margin-bottom: 8px; }
        .badge { font-size: 0.65rem; color: white; padding: 2px 6px; border-radius: 4px; font-weight: 800; letter-spacing: 0.5px; }
        .v-label { font-size: 0.9rem; font-weight: 700; color: #1e293b; margin-left: 8px; }
        .load-pct { font-size: 0.85rem; font-weight: 800; padding: 2px 6px; border-radius: 4px; }
        .load-pct.good { background: #dcfce7; color: #15803d; }
        .load-pct.low { background: #fef9c3; color: #a16207; }
        
        .trip-metrics { font-size: 0.75rem; color: #64748b; display: flex; gap: 12px; font-weight: 500; }
        
        .trip-details { margin-top: 15px; padding-top: 12px; border-top: 1px dashed #cbd5e1; }
        .stop-item { display: flex; gap: 12px; margin-bottom: 12px; position: relative; }
        .stop-item::before { content: ''; position: absolute; left: 11px; top: 22px; bottom: -14px; width: 2px; background: #e2e8f0; z-index: 0; }
        .stop-item:last-child::before { display: none; }
        .stop-marker { width: 24px; height: 24px; border-radius: 50%; color: white; font-size: 0.7rem; display: flex; align-items: center; justify-content: center; font-weight: 800; z-index: 1; flex-shrink: 0; }
        .stop-info { flex: 1; text-align: left; }
        .stop-name { font-size: 0.8rem; font-weight: 700; color: #334155; }
        .stop-addr { font-size: 0.75rem; color: #475569; margin: 2px 0; } 
        .stop-time { font-size: 0.7rem; color: #dc2626; font-weight: bold; margin: 2px 0; }
        .stop-detail { font-size: 0.7rem; color: #059669; margin: 2px 0; }
        .stop-meta { font-size: 0.65rem; color: #94a3b8; }
        
        .map-wrapper { flex: 1; height: 100%; position: relative; }
        .spinner-mini { width: 14px; height: 14px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.8s linear infinite; display: inline-block; margin-right: 5px; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

export default App;