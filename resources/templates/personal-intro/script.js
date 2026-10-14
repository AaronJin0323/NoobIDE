// script.js 是"交互行为"：让网页动起来（比如点击按钮后发生什么）。

// 你的名字：改成你自己的名字试试
const userName = '小雨';

// 找到页面上的按钮和显示消息的段落
const greetButton = document.querySelector('#greet-button');
const message = document.querySelector('#message');

// 当按钮被点击时，显示一句问候
greetButton.addEventListener('click', function () {
  message.textContent = '你好！很高兴认识你，我是' + userName + '。';
});
