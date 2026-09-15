import { mount } from 'svelte'
import '@fontsource-variable/inter'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/chakra-petch/latin-700.css'
import './app.css'
import './redesign.css'
import App from './App.svelte'

export default mount(App, { target: document.getElementById('app')! })
