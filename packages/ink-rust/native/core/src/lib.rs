#![forbid(unsafe_code)]

//! 单 owner 的纯数据场景；不实现布局、终端输出或 Unicode 显示宽度。
//! 限额约束 payload 与部分验证/克隆估算，不覆盖全部工作，也不是 RSS 硬上限。
//! visits 的具体计数范围见 Limits::visits；不可恢复 OOM 可以终止进程。

mod session;

pub use session::*;
