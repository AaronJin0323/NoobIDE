import { greet } from './util.mjs';

document.getElementById('module').textContent = greet('模块');
document.body.dataset.module = 'ok';

const response = await fetch('data/data.json');
const data = await response.json();
document.getElementById('data').textContent = data.message;
document.body.dataset.data = 'ok';
