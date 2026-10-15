// S16.5: thousands of different console errors plus one error repeated just as often, in bursts of 400 messages
// (below the S05.3 flood guard, so every message reaches the problem store), then one uncaught error.
const TOTAL = 3000;
let sent = 0;
function burst() {
  for (let k = 0; k < 200 && sent < TOTAL; k++) {
    console.error('不同的错误 ' + sent);
    console.error('同一个错误');
    sent += 1;
  }
  if (sent < TOTAL) {
    setTimeout(burst, 150);
    return;
  }
  document.body.dataset.sent = String(sent);
  洪水之后的错误();
}
burst();
