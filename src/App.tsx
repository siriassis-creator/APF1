// @ts-nocheck
import React, { useState } from 'react';
import { GoogleMap, useJsApiLoader, DirectionsRenderer, MarkerF } from '@react-google-maps/api';
// @ts-ignore
import * as XLSX from 'xlsx';

// --- Styles ---
const containerStyle = { width: '100%', height: '100vh' };
const center = { lat: 13.7563, lng: 100.5018 };
const routeColors = ["#0088FF", "#FF0000", "#00FF00", "#9900FF", "#FF8800", "#00FFFF", "#FF00FF", "#FFFF00", "#000000", "#888888"];

const depotIcon = {
  url: "http://googleusercontent.com/maps.google.com/mapfiles/ms/icons/blue-dot.png", 
  scaledSize: { width: 40, height: 40 }
};

const getLetter = (index: number) => String.fromCharCode(65 + index);

// Helper Distance
function getDistanceFromLatLonInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  var R = 6371; 
  var dLat = deg2rad(lat2-lat1);  
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon/2) * Math.sin(dLon/2)
    ; 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)); 
  var d = R * c; 
  return d;
}

function deg2rad(deg: number) {
  return deg * (Math.PI/180)
}

function App() {
  const [allData, setAllData] = useState<any[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>('');
  
  const [originAddress, setOriginAddress] = useState<string>('บริษัท อำพลฟูดส์ โพรเซสซิ่ง จำกัด');
  const [maxWeight, setMaxWeight] = useState<number>(3000); 
  const [maxStops, setMaxStops] = useState<number>(20);
  const [isRoundTrip, setIsRoundTrip] = useState<boolean>(true); 
  
  const [filteredOrders, setFilteredOrders] = useState<any[]>([]);
  const [routeResults, setRouteResults] = useState<any[]>([]); 
  const [depotPos, setDepotPos] = useState<any>(null); 
  const [activeTripId, setActiveTripId] = useState<number | null>(null); 
  const [errorMsg, setErrorMsg] = useState<string>('');
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
      if (!bstr) return;

      const wb = XLSX.read(bstr, { type: 'binary' });
      const wsname = wb.SheetNames[0];
      const data = XLSX.utils.sheet_to_json(wb.Sheets[wsname], { raw: false }) as any[];

      if (data.length === 0) return;

      const cleanedData = data.map(row => {
        const newRow: any = {};
        Object.keys(row).forEach(key => newRow[key.trim()] = row[key]);
        return newRow;
      });

      const dates = [...new Set(cleanedData.map((item: any) => item['Date']))].filter(d => d) as string[];
      setAvailableDates(dates);
      setAllData(cleanedData);
      
      if (dates.length > 0) handleDateChange(dates[0], cleanedData);
    };
    reader.readAsBinaryString(file);
  };

  const handleDateChange = (date: string, sourceData = allData) => {
    setSelectedDate(date);
    const dailyOrders = sourceData.filter((row: any) => row['Date'] === date);
    
    const formatted = dailyOrders.map((row: any) => ({
      name: row['Ship-to Name'],
      address: `${row['Ship-to Name']} ${row['District']} ${row['Province']}`, 
      region: row['Region'] || '',
      province: row['Province'] || '',
      district: row['District'] || '',
      weight: parseFloat(row['#Kg.'] || '0'),
      lat: null, 
      lng: null, 
      raw: row
    }));

    setFilteredOrders(formatted);
    setRouteResults([]); 
    setDepotPos(null);
    setActiveTripId(null);
    setErrorMsg('');
    setStatusMsg('');
  };

  const geocodeOrders = async () => {
    if (filteredOrders.length === 0) return;
    setIsGeocoding(true);
    setErrorMsg('');
    setStatusMsg(`กำลังค้นหาพิกัด ${filteredOrders.length} จุด (อาจใช้เวลาสักครู่)...`);

    const geocoder = new (window as any).google.maps.Geocoder();
    const updatedOrders = [...filteredOrders];
    let successCount = 0;

    try {
        const depotResult = await geocoder.geocode({ address: originAddress });
        if (depotResult.results[0]) {
            const loc = depotResult.results[0].geometry.location;
            setDepotPos({ lat: loc.lat(), lng: loc.lng() });
        }
    } catch (e) {
        console.warn("Depot geocode failed");
    }

    for (let i = 0; i < updatedOrders.length; i++) {
        if (updatedOrders[i].lat) continue; 

        try {
            await new Promise(r => setTimeout(r, 300)); 
            
            const res = await geocoder.geocode({ address: updatedOrders[i].address });
            if (res.results[0]) {
                const loc = res.results[0].geometry.location;
                updatedOrders[i].lat = loc.lat();
                updatedOrders[i].lng = loc.lng();
                successCount++;
                setStatusMsg(`ค้นหาพิกัด... ${successCount}/${updatedOrders.length}`);
            }
        } catch (error) {
            console.warn(`Geocode failed for ${updatedOrders[i].name}:`, error);
        }
    }

    setFilteredOrders(updatedOrders);
    setIsGeocoding(false);
    setStatusMsg(`ค้นหาพิกัดเสร็จสิ้น! เจอ ${successCount} จุด พร้อมคำนวณระยะทาง`);
  };

  async function calculateRoute() {
    const hasCoords = filteredOrders.some((o: any) => o.lat !== null);
    if (!hasCoords) {
        setErrorMsg("กรุณากด 'ค้นหาพิกัด' ก่อน เพื่อให้ระบบคำนวณระยะทางได้");
        return;
    }

    setIsCalculating(true);
    setRouteResults([]);
    setActiveTripId(null);
    setErrorMsg('');

    const directionsService = new (window as any).google.maps.DirectionsService();
    const LIMIT_PER_TRIP = Math.min(maxStops, 23); 

    let unassigned = [...filteredOrders];
    const vehicles: any[] = [];
    
    let depotLat = depotPos ? depotPos.lat : 13.7563;
    let depotLng = depotPos ? depotPos.lng : 100.5018;

    while (unassigned.length > 0) {
        let currentVehicle: any = { orders: [], weight: 0 };
        let currentLat = depotLat;
        let currentLng = depotLng;
        let currentProvince: string | null = null;

        while (true) {
            let candidates = unassigned.filter((o: any) => {
                const newWeight = Number((currentVehicle.weight + o.weight).toFixed(2));
                return newWeight <= maxWeight && currentVehicle.orders.length < LIMIT_PER_TRIP;
            });

            if (candidates.length === 0) break; 

            if (currentProvince) {
                const sameProvCandidates = candidates.filter((o: any) => o.province === currentProvince);
                if (sameProvCandidates.length > 0) {
                    candidates = sameProvCandidates;
                } else {
                    currentProvince = null; 
                }
            }

            candidates.sort((a: any, b: any) => {
                const distA = getDistanceFromLatLonInKm(currentLat, currentLng, a.lat || depotLat, a.lng || depotLng);
                const distB = getDistanceFromLatLonInKm(currentLat, currentLng, b.lat || depotLat, b.lng || depotLng);
                
                if (Math.abs(distA - distB) < 0.1) { 
                    return a.name.localeCompare(b.name); 
                }
                return distA - distB;
            });

            const best = candidates[0];

            currentVehicle.orders.push(best);
            currentVehicle.weight += best.weight;
            
            if (best.lat) {
                currentLat = best.lat;
                currentLng = best.lng;
            }
            if (!currentProvince) {
                currentProvince = best.province; 
            }

            const index = unassigned.findIndex((u: any) => u === best);
            if (index > -1) unassigned.splice(index, 1);
        }

        if (currentVehicle.orders.length > 0) {
            vehicles.push(currentVehicle);
        } else {
            if (unassigned.length > 0) {
                const stuck = unassigned.shift();
                if (stuck) {
                  vehicles.push({ orders: [stuck], weight: stuck.weight, isOversized: true });
                }
            }
        }
    }

    try {
      const results: any[] = [];
      let foundDepot: any = null;

      for (let i = 0; i < vehicles.length; i++) {
        const vehicle = vehicles[i];
        
        let destination = originAddress;
        let waypointsData = [...vehicle.orders];
        
        if (!isRoundTrip && waypointsData.length > 0) {
             const lastOrder = waypointsData.pop(); 
             if (lastOrder) destination = lastOrder.address;
        }

        const waypoints = waypointsData.map((order: any) => ({
          location: order.address,
          stopover: true
        }));

        await new Promise(r => setTimeout(r, 400)); 

        let resultData: any = null;
        let distKm = 0;
        let orderedStops: any[] = [];
        let legs: any[] = [];

        try {
            const result = await directionsService.route({
                origin: originAddress,
                destination: destination,
                waypoints: waypoints,
                optimizeWaypoints: true, 
                travelMode: (window as any).google.maps.TravelMode.DRIVING,
            });
            
            if (result && result.routes && result.routes.length > 0) {
                resultData = result;
                if (result.routes[0].legs) {
                    distKm = result.routes[0].legs.reduce((acc: number, leg: any) => acc + (leg.distance?.value || 0), 0) / 1000;
                    legs = result.routes[0].legs;
                }
                
                const waypointOrder = result.routes[0].waypoint_order;
                
                if (isRoundTrip) {
                    orderedStops = waypointOrder.map((index: number) => vehicle.orders[index]);
                } else {
                    const middleStops = waypointOrder.map((index: number) => waypointsData[index]);
                    const lastStop = vehicle.orders[vehicle.orders.length - 1]; 
                    orderedStops = [...middleStops, lastStop];
                }

                if (!foundDepot && result.routes[0].legs[0]) {
                    const startLoc = result.routes[0].legs[0].start_location;
                    foundDepot = { lat: startLoc.lat(), lng: startLoc.lng() };
                }

                results.push({
                  id: i + 1,
                  data: resultData,
                  weight: vehicle.weight,
                  orderCount: vehicle.orders.length,
                  distanceKm: distKm.toFixed(1),
                  firstDrop: vehicle.orders[0].district, 
                  isOversized: !!vehicle.isOversized || (vehicle.weight > maxWeight),
                  orderedStops: orderedStops,
                  legs: legs, 
                  color: routeColors[i % routeColors.length]
                });
            } else {
               console.warn("No routes found for vehicle " + (i+1));
            }

        } catch (err) {
            console.warn("Routing failed for vehicle " + (i+1));
        }
      }

      setRouteResults(results);
      if (foundDepot) setDepotPos(foundDepot);
      setStatusMsg(`จัดเส้นทางเสร็จสิ้น! ได้ทั้งหมด ${results.length} เที่ยว`);

    } catch (error: any) {
      console.error("Routing Error:", error);
      setErrorMsg("เกิดข้อผิดพลาด: " + (error.message || error));
    } finally {
      setIsCalculating(false);
    }
  }

  // --- New Function: Export to Excel ---
  const handleExportExcel = () => {
    if (routeResults.length === 0) return;

    // Flatten data: แปลงโครงสร้างจาก Trip -> Stops ให้เป็น Row เดียวกันหมด
    const exportData: any[] = [];

    routeResults.forEach((trip) => {
        trip.orderedStops.forEach((stop: any, index: number) => {
            // ดึงข้อมูล Original (raw) มาใส่ด้วยถ้าต้องการ
            exportData.push({
                "Trip No": trip.id,
                "Stop Seq": index + 1,
                "Date": selectedDate,
                "Ship-to Name": stop.name,
                "Address": stop.address,
                "Province": stop.province,
                "District": stop.district,
                "Weight (kg)": stop.weight,
                "Distance From Prev": trip.legs[index]?.distance?.text || "Start",
                // ถ้าอยากได้ฟิลด์อื่นจาก Excel ต้นฉบับ
                // "Order ID": stop.raw?.['Order No'] || "", 
            });
        });
    });

    // Create Worksheet & Workbook
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Route Plan");

    // Save File
    XLSX.writeFile(wb, `Delivery_Plan_${selectedDate}.xlsx`);
  };

  const renderSidebarContent = () => {
    if (activeTripId !== null) {
      const trip = routeResults.find((t: any) => t.id === activeTripId);
      if (!trip) return null;
      
      return (
        <div style={{ animation: 'fadeIn 0.3s', textAlign: 'left' }}>
          <button onClick={() => setActiveTripId(null)} style={{ marginBottom: '15px', padding: '5px 10px', cursor: 'pointer', backgroundColor: '#eee', border: 'none', borderRadius: '4px' }}>
            ← กลับไปหน้าสรุป
          </button>
          
          <div style={{ padding: '15px', borderLeft: `5px solid ${trip.color}`, backgroundColor: 'white', borderRadius: '8px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
            <h3 style={{ margin: '0 0 10px 0' }}>🚛 รถคันที่ {trip.id}</h3>
            <div style={{ fontSize: '0.9rem' }}><b>ระยะทางรวม:</b> {trip.distanceKm} km</div>
            <div style={{ fontSize: '0.9rem', marginBottom:'15px' }}><b>นน.รวม:</b> {trip.weight.toLocaleString()} kg</div>
            
            <h4 style={{ borderBottom: '1px solid #ddd', paddingBottom: '5px' }}>ลำดับการวิ่ง (Sequence)</h4>
            <ul style={{ paddingLeft: '0', listStyle: 'none', fontSize: '0.9rem', textAlign: 'left' }}>
              <li style={{ padding: '10px 0', borderBottom: '1px dashed #eee', display: 'flex', gap: '10px' }}>
                <span style={{ fontWeight: 'bold', color: 'white', backgroundColor: '#d35400', width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', flexShrink: 0 }}>A</span>
                <div>
                    <div style={{ fontWeight: 'bold', color: '#d35400' }}>จุดเริ่มต้น (คลังสินค้า)</div>
                    <div style={{ fontSize: '0.8rem', color: '#666' }}>{originAddress}</div>
                </div>
              </li>
              {trip.orderedStops.map((stop: any, idx: number) => {
                const markerLetter = getLetter(idx + 1);
                const legInfo = trip.legs[idx];
                const distanceText = legInfo && legInfo.distance ? `(+ ${legInfo.distance.text})` : '';
                return (
                  <li key={idx} style={{ padding: '10px 0', borderBottom: '1px dashed #eee', display: 'flex', gap: '10px' }}>
                    <span style={{ fontWeight: 'bold', color: 'white', backgroundColor: '#2c3e50', width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', flexShrink: 0 }}>{markerLetter}</span>
                    <div style={{ flexGrow: 1 }}>
                      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                          <span style={{ fontWeight: 'bold' }}>{stop.name}</span>
                          <span style={{ fontSize: '0.75rem', color: '#0088FF', whiteSpace:'nowrap' }}>{distanceText}</span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>{stop.district}, {stop.province}</div>
                      <div style={{ fontSize: '0.75rem', color: '#27ae60' }}>📦 {stop.weight} kg</div>
                    </div>
                  </li>
                );
              })}
              {isRoundTrip ? (
                  <li style={{ padding: '10px 0', display: 'flex', gap: '10px' }}>
                     <span style={{ fontWeight: 'bold', color: 'white', backgroundColor: '#d35400', width: '24px', height: '24px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', flexShrink: 0 }}>{getLetter(trip.orderedStops.length + 1)}</span>
                    <div><div style={{ fontWeight: 'bold', color: '#d35400' }}>กลับคลังสินค้า</div><div style={{ fontSize: '0.8rem', color: '#0088FF' }}>{trip.legs[trip.legs.length - 1]?.distance?.text ? `(+ ${trip.legs[trip.legs.length - 1].distance?.text})` : ''}</div></div>
                  </li>
              ) : (
                  <li style={{ padding: '10px 0', display: 'flex', gap: '10px', opacity: 0.5 }}>
                    <div style={{ fontSize: '0.85rem', fontStyle: 'italic' }}>⛔ จบงานที่ลูกค้าคนสุดท้าย (ไม่กลับคลัง)</div>
                  </li>
              )}
            </ul>
          </div>
        </div>
      );
    }

    return (
      <div style={{ textAlign: 'left' }}>
        <div style={{ backgroundColor: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 6px rgba(0,0,0,0.05)', marginBottom: '20px' }}>
            <h2 style={{ margin: '0 0 15px 0', color: '#2c3e50', fontSize:'1.4rem' }}>⚙️ ตั้งค่าการจัดส่ง</h2>
            
            <div style={{ marginBottom: '12px' }}>
                <label style={{display:'block', marginBottom:'4px', fontWeight:'600', fontSize:'0.85rem'}}>1. อัปโหลดไฟล์ Excel</label>
                <input type="file" onChange={handleFileUpload} accept=".xlsx, .xls" style={{fontSize:'0.85rem'}}/>
            </div>

            {allData.length > 0 && (
            <>
                {/* Geocode Button */}
                <div style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#fff8e1', borderRadius: '6px', border: '1px solid #ffe082' }}>
                    <div style={{fontSize:'0.85rem', marginBottom:'5px', fontWeight:'bold', color:'#f57f17'}}>ขั้นแรก: ต้องหาพิกัดก่อน</div>
                    <button 
                        onClick={geocodeOrders} 
                        disabled={isGeocoding || filteredOrders.some((o: any) => o.lat)}
                        style={{ width: '100%', padding: '8px', backgroundColor: filteredOrders.some((o: any) => o.lat) ? '#4caf50' : '#ff9800', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
                    >
                        {isGeocoding ? 'กำลังค้นหาพิกัด...' : filteredOrders.some((o: any) => o.lat) ? '✅ มีพิกัดครบแล้ว' : '📍 1. ค้นหาพิกัด (Geocode)'}
                    </button>
                    {statusMsg && <div style={{fontSize:'0.75rem', marginTop:'5px', color:'#666'}}>{statusMsg}</div>}
                </div>

                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px' }}>
                  <div style={{ marginBottom: '10px', gridColumn: '1 / -1' }}>
                      <label style={{display:'block', marginBottom:'4px', fontWeight:'600', fontSize:'0.85rem'}}>2. จุดเริ่มต้น</label>
                      <input type="text" value={originAddress} onChange={(e) => setOriginAddress(e.target.value)} style={{width:'100%', padding:'8px', border:'1px solid #ccc', borderRadius:'4px', boxSizing:'border-box'}} />
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                      <label style={{display:'block', marginBottom:'4px', fontWeight:'600', fontSize:'0.85rem'}}>3. รับนน. (Kg)</label>
                      <input type="number" value={maxWeight} onChange={(e) => setMaxWeight(Number(e.target.value))} style={{width:'100%', padding:'8px', border:'1px solid #ccc', borderRadius:'4px', boxSizing:'border-box'}} />
                  </div>
                  <div style={{ marginBottom: '10px' }}>
                      <label style={{display:'block', marginBottom:'4px', fontWeight:'600', fontSize:'0.85rem'}}>4. จุดส่งสูงสุด</label>
                      <input type="number" value={maxStops} onChange={(e) => setMaxStops(Number(e.target.value))} min="1" max="23" style={{width:'100%', padding:'8px', border:'1px solid #ccc', borderRadius:'4px', boxSizing:'border-box'}} />
                  </div>
                </div>

                <div style={{ marginBottom: '15px', padding: '10px', backgroundColor: '#f0f2f5', borderRadius: '6px' }}>
                    <label style={{display:'flex', alignItems:'center', cursor:'pointer', gap:'10px'}}>
                        <input type="checkbox" checked={isRoundTrip} onChange={(e) => setIsRoundTrip(e.target.checked)} style={{ width: '18px', height: '18px' }}/>
                        <span style={{ fontSize: '0.9rem', fontWeight: '600' }}>วิ่งงานเสร็จ วนกลับคลัง (Round Trip)</span>
                    </label>
                </div>

                <div style={{ marginBottom: '15px' }}>
                    <label style={{display:'block', marginBottom:'4px', fontWeight:'600', fontSize:'0.85rem'}}>5. เลือกวันที่</label>
                    <select value={selectedDate} onChange={(e) => handleDateChange(e.target.value)} style={{width:'100%', padding:'8px', border:'1px solid #ccc', borderRadius:'4px', backgroundColor:'#fff'}}>
                        {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
                    </select>
                </div>

                <button onClick={calculateRoute} disabled={isCalculating || isGeocoding || filteredOrders.length === 0} style={{ width: '100%', padding: '12px', backgroundColor: isCalculating ? '#bdc3c7' : '#27ae60', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
                    {isCalculating ? 'กำลังประมวลผล...' : '2. เริ่มจัดเส้นทาง 🚀'}
                </button>
            </>
            )}
        </div>

        {errorMsg && <div style={{ color: '#c0392b', marginBottom: '20px', padding: '10px', backgroundColor: '#fadbd8', borderRadius: '6px' }}>{errorMsg}</div>}

        {routeResults.length > 0 && (
            <div>
                {/* ปุ่ม Export อยู่ตรงนี้ */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px', padding: '10px', backgroundColor: '#e8f6f3', borderRadius: '6px', border: '1px solid #a2d9ce' }}>
                    <b style={{color: '#16a085'}}>สรุป: {routeResults.length} คัน</b>
                    <button 
                        onClick={handleExportExcel}
                        style={{ padding: '6px 12px', backgroundColor: '#2196F3', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 'bold' }}
                    >
                        📥 Export Excel
                    </button>
                </div>

                {routeResults.map((trip: any) => (
                    <div key={trip.id} onClick={() => setActiveTripId(trip.id)} style={{ marginBottom: '12px', padding: '15px', backgroundColor: 'white', borderRadius: '8px', borderLeft: `6px solid ${trip.color}`, boxShadow: '0 2px 4px rgba(0,0,0,0.05)', cursor: 'pointer' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom:'6px' }}><b style={{ color: '#2c3e50' }}>รถคันที่ {trip.id} {trip.isOversized && '⚠️'}</b><span style={{ fontSize: '0.8rem', padding: '3px 8px', borderRadius: '12px', backgroundColor: '#f0f2f5' }}>{trip.distanceKm} km</span></div>
                        <div style={{ fontSize: '0.85rem', color:'#555' }}>📍 โซน: <b>{trip.firstDrop}</b> ...</div>
                    </div>
                ))}
            </div>
        )}
      </div>
    );
  };

  if (!isLoaded) return <div style={{display:'flex', justifyContent:'center', alignItems:'center', height:'100vh'}}>Loading Google Maps...</div>;

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', fontFamily: "'Sarabun', sans-serif", overflow: 'hidden' }}>
      <div style={{ width: '400px', minWidth: '400px', height: '100%', display: 'flex', flexDirection: 'column', borderRight: '1px solid #e0e0e0', backgroundColor: '#f4f6f8', zIndex: 2 }}>
        <div style={{ padding: '20px', overflowY: 'auto', flexGrow: 1 }}>{renderSidebarContent()}</div>
      </div>
      <div style={{ flexGrow: 1, position: 'relative' }}>
        <GoogleMap mapContainerStyle={containerStyle} center={depotPos || center} zoom={9} options={{ disableDefaultUI: false, zoomControl: true }}>
          {depotPos && <MarkerF position={depotPos} icon={depotIcon} zIndex={1000} />}
          {routeResults.map((trip: any) => {
            if ((activeTripId !== null && trip.id !== activeTripId) || !trip.data) return null;
            return (
                <DirectionsRenderer 
                  key={trip.id} 
                  directions={trip.data} 
                  options={{
                    polylineOptions: { strokeColor: trip.color, strokeWeight: activeTripId === trip.id ? 8 : 5, zIndex: activeTripId === trip.id ? 999 : 10 },
                    suppressMarkers: false,
                    preserveViewport: true
                  }}
                />
            );
          })}
        </GoogleMap>
      </div>
    </div>
  );
}

export default App;