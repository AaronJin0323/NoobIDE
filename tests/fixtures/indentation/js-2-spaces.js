// script.js 是"交互行为"：让网页动起来（比如点击按钮后发生什么）。

let count = 0;

const countText = document.querySelector('#count');
const plusButton = document.querySelector('#plus-button');
const minusButton = document.querySelector('#minus-button');

function showCount() {
  countText.textContent = count;
  if (count < 0) {
    countText.classList.add('negative');
  } else {
    countText.classList.remove('negative');
  }
}

plusButton.addEventListener('click', function () {
  count = count + 1;
  showCount();
});

minusButton.addEventListener('click', function () {
  count = count - 1;
  showCount();
});
