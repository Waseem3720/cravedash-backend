async function testGoogle(keys) {
  const api_key = keys && keys.api_key;
  if (!api_key) throw new Error('Google Maps API key is required');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent('London UK')}&key=${encodeURIComponent(api_key)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
    throw new Error(data.error_message || data.status);
  }
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(data.error_message || data.status || `Maps failed (${res.status})`);
  }
  return { ok: true, provider: 'google_maps', status: data.status };
}

async function geocodeGoogle(keys, { address, postcode }) {
  const q = address || postcode;
  if (!q) throw new Error('address or postcode required');
  const api_key = keys.api_key;
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&key=${encodeURIComponent(api_key)}`;
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (data.status !== 'OK') throw new Error(data.error_message || data.status || 'Geocode failed');
  return (data.results || []).map((r) => ({
    formatted: r.formatted_address,
    lat: r.geometry && r.geometry.location && r.geometry.location.lat,
    lng: r.geometry && r.geometry.location && r.geometry.location.lng,
    place_id: r.place_id,
  }));
}

async function testPostcode(keys) {
  const api_key = keys && keys.api_key;
  if (!api_key) throw new Error('getAddress.io API key is required');
  const res = await fetch(
    `https://api.getAddress.io/autocomplete/SW1A?api-key=${encodeURIComponent(api_key)}&top=1`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.Message || data.message || `getAddress failed (${res.status})`);
  }
  return { ok: true, provider: 'getaddress', suggestions: (data.suggestions || []).length };
}

async function lookupPostcode(keys, { postcode }) {
  if (!postcode) throw new Error('postcode required');
  const api_key = keys.api_key;
  const pc = String(postcode).replace(/\s+/g, '');
  const res = await fetch(
    `https://api.getAddress.io/find/${encodeURIComponent(pc)}?api-key=${encodeURIComponent(api_key)}&expand=true`,
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.Message || data.message || `Postcode lookup failed (${res.status})`);
  return {
    postcode: data.postcode,
    latitude: data.latitude,
    longitude: data.longitude,
    addresses: data.addresses || [],
  };
}

module.exports = {
  maps: { testConnection: testGoogle, geocode: geocodeGoogle },
  postcode: { testConnection: testPostcode, lookup: lookupPostcode },
};
