import './styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { resolveLang, setLanguage } from './i18n/runtime'

// Idioma antes do primeiro desenho (o da última vez; 'auto' = o do Windows). O App confirma com as configurações.
let pref = 'auto'
try {
  pref = localStorage.getItem('iac-lang') ?? 'auto'
} catch {
  // sem localStorage
}
setLanguage(resolveLang(pref))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
