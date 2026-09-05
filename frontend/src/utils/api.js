import axios from 'axios';

// When backend is running → http://localhost:5000/api
// When backend is offline → requests fail silently, pages use mock data
const BASE_URL = 'http://localhost:8000';

const API = axios.create({
  baseURL: BASE_URL,
  timeout: 30000, // 4 seconds — fail fast so UI shows mock data quickly
});

// Attach JWT token to every request
API.interceptors.request.use((config) => {
  const token = localStorage.getItem('awaaz_token');
  if (token && token !== 'demo-token') {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle responses — only redirect on 401 when backend actually responds
API.interceptors.response.use(
  (response) => response,
  (error) => {
    // Only logout on real 401 (not network errors)
    if (error.response?.status === 401) {
      localStorage.removeItem('awaaz_token');
      localStorage.removeItem('awaaz_user');
      window.location.href = '/login';
    }
    // Re-throw so pages can catch and use mock data
    return Promise.reject(error);
  }
);

export default API;