// Ordinary browser JavaScript that runs fine. Without beginner tuning, type checking would flag most lines.
const name = '林小雨';
const input = document.getElementById('name');
input.value = name;
const box = document.querySelector('.box');
box.style.width = 100;
box.textContent = '5' * 2;
const total = Math.max('1', 2);
function greet(person, greeting) {
  return greeting + person;
}
greet('Lin');
const counter = { count: 0 };
counter.count = counter.count + '1';
window.scrollTo(0, 0);
if (document.hidden == 'yes') {
  console.log(total);
}
// Control: one real mistake, so the file is known to have been checked.
console.log(missingName);
