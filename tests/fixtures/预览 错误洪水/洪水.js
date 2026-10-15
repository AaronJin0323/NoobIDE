// S16.5: 3000 different console errors plus one repeated error, then one uncaught error. Each burst stays within
// the in-page console limit (200 per second per document, decision 0016), so all of it reaches the problem store.
const TOTAL = 3000;
let sent = 0;
function burst() {
  for (let k = 0; k < 140 && sent < TOTAL; k++) {
    console.error('不同的错误 ' + sent);
    if (k % 3 === 0) console.error('同一个错误');
    sent += 1;
  }
  if (sent < TOTAL) {
    setTimeout(burst, 1050);
    return;
  }
  document.body.dataset.sent = String(sent);
  洪水之后的错误();
}
burst();
