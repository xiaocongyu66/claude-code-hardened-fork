use ink_rust_core::{Kind, Limits, NodeRef, NodeSpec, Op, Session};

fn main() -> Result<(), ink_rust_core::Error> {
    let mut session = Session::new(Limits::default())?;
    let root = session.stats().root;
    let first = session.apply_batch(
        0,
        &[
            Op::Create {
                temp: 0,
                parent: NodeRef::Id(root),
                kind: NodeSpec::Box,
            },
            Op::Create {
                temp: 1,
                parent: NodeRef::Temp(0),
                kind: NodeSpec::Text("hello"),
            },
        ],
    )?;
    let text = first.created[1].1;
    session.apply_batch(
        1,
        &[Op::UpdateText {
            node: NodeRef::Id(text),
            text: "你好 Rust",
        }],
    )?;
    for snapshot in session.inspect(&[text])? {
        if let Kind::Text(text) = snapshot.kind {
            // 只输出确定性数据，不把 scalar 数称为终端显示宽度。
            println!(
                "text={text:?} bytes={} scalars={}",
                text.len(),
                text.chars().count()
            );
        }
    }
    session.apply_batch(
        2,
        &[
            Op::Delete {
                node: NodeRef::Id(text),
            },
            Op::Delete {
                node: NodeRef::Id(first.created[0].1),
            },
        ],
    )?;
    let stats = session.stats();
    println!(
        "revision={} live_nodes={} live_text_bytes={}",
        stats.revision, stats.live_nodes, stats.live_text_bytes
    );
    session.close();
    println!(
        "closed={} slots={}",
        session.stats().closed,
        session.stats().slots
    );
    Ok(())
}
