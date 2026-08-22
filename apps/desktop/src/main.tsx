import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.js'
import './stil.css'

const wurzel = document.getElementById('app')
if (wurzel === null) throw new Error('Kein Wurzelelement #app gefunden')
createRoot(wurzel).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
