// 演练来源的薄客户端：只封装本流程用到的来源接口。
export function createSourceClient(origin) {
  async function request(path, options) {
    const response = await fetch(origin + path, options);
    const text = await response.text();
    if (!response.ok) {
      let detail = text;
      try { detail = JSON.parse(text); } catch { /* 保留原文 */ }
      const error = new Error('来源 ' + path + ' 回应 ' + response.status);
      error.status = response.status;
      error.detail = detail;
      throw error;
    }
    return text;
  }
  const getJson = async path => JSON.parse(await request(path));
  const postJson = (path, body) => request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(text => JSON.parse(text));
  return {
    manifest: () => getJson('/device/manifest'),
    exports: async packet => (await request('/device/exports?packet=' + encodeURIComponent(packet)))
      .split('\n').filter(Boolean).map(line => JSON.parse(line)),
    calibration: () => getJson('/device/calibration'),
    transfers: () => getJson('/locker/transfers'),
    logbook: () => getJson('/station/logbook'),
    confirmReceipt: body => postJson('/device/receipts', body),
    schoolPickup: body => postJson('/school/pickups', body),
  };
}
