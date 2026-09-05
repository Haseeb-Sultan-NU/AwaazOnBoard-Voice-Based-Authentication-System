import React, { createContext, useContext, useState } from 'react';
import API from '../utils/api';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('awaaz_user');
    return stored ? JSON.parse(stored) : null;
  });
  const [loading, setLoading] = useState(false);

  const login = async (cnic, password) => {
    setLoading(true);
    try {
      // FIX 1: Send 'cnic' instead of 'email' to satisfy FastAPI
      const res = await API.post('/login', { cnic, password });
      
      const userData = { 
        id: res.data.user_id, 
        cnic: res.data.cnic,             // <-- Added
        full_name: res.data.full_name,   // <-- Added
        role: 'user', 
        is_enrolled: res.data.is_enrolled 
      };
      localStorage.setItem('awaaz_user', JSON.stringify(userData));
      setUser(userData);
      
      return { success: true, user: userData };
    } catch (err) {
      // FIX 2: Safely parse FastAPI 422 Arrays so React doesn't crash
      let errMsg = 'Login failed';
      const detail = err.response?.data?.detail;
      
      if (typeof detail === 'string') {
        errMsg = detail;
      } else if (Array.isArray(detail)) {
        errMsg = "Validation error: " + detail[0].msg;
      }
      
      return { success: false, message: errMsg };
    } finally {
      setLoading(false);
    }
  };

  const register = async (data) => {
    setLoading(true);
    try {
      await API.post('/signup', data);
      return { success: true };
    } catch (err) {
      let errMsg = 'Registration failed';
      const detail = err.response?.data?.detail;
      
      if (typeof detail === 'string') {
        errMsg = detail;
      } else if (Array.isArray(detail)) {
        errMsg = "Validation error: " + detail[0].msg;
      }
      
      return { success: false, message: errMsg };
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('awaaz_user');
    setUser(null);
  };

  const refreshUser = async () => {
    return user; 
  };

  return (
    <AuthContext.Provider value={{ user, setUser, loading, login, register, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);