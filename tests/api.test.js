const request = require('supertest');
const app = require('../src/server');

describe('API Health & Basic Routes', () => {
  
  test('GET /health should return 200 OK', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
  });

  test('GET /api/non-existent-route should return 404', async () => {
    const response = await request(app).get('/api/non-existent-route');
    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
  });

});
