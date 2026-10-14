// script.js 是"交互行为"：让网页动起来（比如点击按钮后发生什么）。

// 现在的数字，从 0 开始
let count = 0;

// 找到页面上的数字和三个按钮
const countText = document.querySelector('#count');
const plusButton = document.querySelector('#plus-button');
const minusButton = document.querySelector('#minus-button');
const resetButton = document.querySelector('#reset-button');

// 把最新的数字显示到页面上
function showCount() {
  countText.textContent = count;
}

plusButton.addEventListener('click', function () {
  count = count + 1;
  showCount();
});

minusButton.addEventListener('click', function () {
  count = count - 1;
  showCount();
});

resetButton.addEventListener('click', function () {
  count = 0;
  showCount();
});
