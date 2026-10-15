// 不同的调用方式：每条消息都保留这个文件和行号（S05.4，决定 0016）。
const say = console.log;
say('保存的引用');
['数组回调'].forEach(console.info);
console.warn.call(console, '通过 call');
const bound = console.log.bind(console, '通过 bind'); bound();
alert('提示框');
