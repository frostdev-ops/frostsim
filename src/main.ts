import { mount } from 'svelte'
import '@fontsource-variable/inter'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/chakra-petch/latin-700.css'
import './app.css'
import './redesign.css'
import App from './App.svelte'

const target = document.getElementById('app')!
// The initial HTML and the Character screen use the same authored introduction.
target.replaceChildren()
export default mount(App, { target })
