import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import './env.css'
import './mobile.css'
import { installBackend } from '../../backend/api'

installBackend()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
