use ink_rust_core::{ErrorCode, Kind, Limits, NodeId, NodeRef, NodeSpec, Op, Session};

fn create(temp: u32, parent: NodeRef, kind: NodeSpec<'_>) -> Op<'_> {
    Op::Create { temp, parent, kind }
}

fn delete(id: NodeId) -> Op<'static> {
    Op::Delete {
        node: NodeRef::Id(id),
    }
}

fn reparent(id: NodeId, parent: NodeId) -> Op<'static> {
    Op::Reparent {
        node: NodeRef::Id(id),
        parent: NodeRef::Id(parent),
    }
}

fn update(id: NodeId, text: &str) -> Op<'_> {
    Op::UpdateText {
        node: NodeRef::Id(id),
        text,
    }
}

fn submit(s: &mut Session, ops: &[Op<'_>]) -> Vec<NodeId> {
    s.apply_batch(s.stats().revision, ops)
        .unwrap()
        .created
        .into_iter()
        .map(|(_, id)| id)
        .collect()
}

fn fail(s: &mut Session, ops: &[Op<'_>], code: ErrorCode) {
    let before = s.stats();
    let root = s.inspect(&[before.root]).unwrap();
    let error = s.apply_batch(before.revision, ops).unwrap_err();
    assert_eq!(error.code, code);
    assert_eq!(s.stats(), before);
    assert_eq!(s.inspect(&[before.root]).unwrap(), root);
}

#[test]
fn root_revision_and_closed() {
    let mut s = Session::new(Limits::default()).unwrap();
    let root = s.stats().root;
    assert_eq!(s.inspect(&[root]).unwrap()[0].kind, Kind::Box);
    assert_eq!(s.apply_batch(0, &[]).unwrap().revision, 0);
    assert_eq!(s.apply_batch(1, &[]).unwrap_err().code, ErrorCode::Revision);
    fail(&mut s, &[delete(root)], ErrorCode::Tree);
    fail(&mut s, &[update(root, "root")], ErrorCode::Tree);
    fail(&mut s, &[reparent(root, root)], ErrorCode::Tree);
    s.close();
    let closed = s.stats();
    s.close();
    assert_eq!(s.stats(), closed);
    assert!(closed.closed);
    assert_eq!(
        (closed.slots, closed.live_nodes, closed.live_text_bytes),
        (0, 0, 0)
    );
    assert_eq!(s.inspect(&[]).unwrap_err().code, ErrorCode::Closed);
    assert_eq!(s.apply_batch(0, &[]).unwrap_err().code, ErrorCode::Closed);
}

#[test]
fn ordered_siblings_reparent_and_postorder_delete() {
    let mut s = Session::new(Limits::default()).unwrap();
    let root = s.stats().root;
    let ids = submit(
        &mut s,
        &[
            create(0, NodeRef::Id(root), NodeSpec::Box),
            create(1, NodeRef::Id(root), NodeSpec::Text("一")),
            create(2, NodeRef::Id(root), NodeSpec::Box),
        ],
    );
    let [a, b, c] = [ids[0], ids[1], ids[2]];
    assert_eq!(s.inspect(&[root]).unwrap()[0].children, ids);
    submit(&mut s, &[reparent(b, root)]);
    assert_eq!(s.inspect(&[root]).unwrap()[0].children, ids);
    submit(&mut s, &[reparent(b, a)]);
    assert_eq!(s.inspect(&[root]).unwrap()[0].children, vec![a, c]);
    assert_eq!(s.inspect(&[a]).unwrap()[0].children, vec![b]);
    fail(&mut s, &[delete(a)], ErrorCode::Tree);
    fail(&mut s, &[reparent(a, a)], ErrorCode::Tree);
    fail(&mut s, &[reparent(c, b)], ErrorCode::Tree);
    submit(&mut s, &[reparent(c, a)]);
    fail(&mut s, &[reparent(a, c)], ErrorCode::Tree);
    submit(&mut s, &[reparent(b, root)]);
    assert_eq!(s.inspect(&[root]).unwrap()[0].children, vec![a, b]);
    submit(&mut s, &[delete(c), delete(a)]);
    assert_eq!(s.inspect(&[root]).unwrap()[0].children, vec![b]);
}

#[test]
fn temp_resolution_and_overlay_cycle() {
    let mut s = Session::new(Limits::default()).unwrap();
    let root = NodeRef::Id(s.stats().root);
    fail(
        &mut s,
        &[create(0, NodeRef::Temp(1), NodeSpec::Box)],
        ErrorCode::Ref,
    );
    fail(
        &mut s,
        &[create(0, root, NodeSpec::Box), create(0, root, NodeSpec::Box)],
        ErrorCode::Ref,
    );
    fail(
        &mut s,
        &[
            create(0, root, NodeSpec::Box),
            create(1, NodeRef::Temp(0), NodeSpec::Box),
            Op::Reparent {
                node: NodeRef::Temp(0),
                parent: NodeRef::Temp(1),
            },
        ],
        ErrorCode::Tree,
    );
    fail(
        &mut s,
        &[
            create(0, root, NodeSpec::Text("x")),
            create(1, NodeRef::Temp(0), NodeSpec::Box),
        ],
        ErrorCode::Tree,
    );
    let ids = submit(
        &mut s,
        &[
            create(0, root, NodeSpec::Box),
            create(1, NodeRef::Temp(0), NodeSpec::Text("x")),
        ],
    );
    assert_eq!(s.inspect(&[ids[0]]).unwrap()[0].children, vec![ids[1]]);
    // temp 删除后不可再次使用或重新声明，墓碑优先于原始节点。
    fail(
        &mut s,
        &[
            create(0, root, NodeSpec::Box),
            Op::Delete {
                node: NodeRef::Temp(0),
            },
            create(0, root, NodeSpec::Box),
        ],
        ErrorCode::Ref,
    );
    fail(
        &mut s,
        &[
            create(0, root, NodeSpec::Box),
            Op::Delete {
                node: NodeRef::Temp(0),
            },
            create(1, NodeRef::Temp(0), NodeSpec::Box),
        ],
        ErrorCode::Id,
    );
}

#[test]
fn rollback_preserves_entire_tree_allocator_and_id_sequence() {
    let mut s = Session::new(Limits::default()).unwrap();
    let root = s.stats().root;
    let ids = submit(
        &mut s,
        &[
            create(0, NodeRef::Id(root), NodeSpec::Box),
            create(1, NodeRef::Id(root), NodeSpec::Text("old")),
        ],
    );
    let all = [root, ids[0], ids[1]];
    let before = s.inspect(&all).unwrap();
    let stats = s.stats();
    let error = s
        .apply_batch(
            1,
            &[
                update(ids[1], "new"),
                reparent(ids[1], ids[0]),
                delete(ids[1]),
                create(0, NodeRef::Id(root), NodeSpec::Text("discard")),
                delete(root),
            ],
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Tree);
    assert_eq!(error.op_index, Some(4));
    assert_eq!(s.stats(), stats);
    assert_eq!(s.inspect(&all).unwrap(), before);
    // Debug 包含私有 slot/generation；无需开放伪造 ID 的生产接口。
    let id = submit(&mut s, &[create(0, NodeRef::Id(root), NodeSpec::Box)])[0];
    assert!(format!("{id:?}").contains("slot: 3, generation: 0"));
    submit(&mut s, &[delete(id)]);
    fail(
        &mut s,
        &[create(0, NodeRef::Id(root), NodeSpec::Box), delete(root)],
        ErrorCode::Tree,
    );
    let reused = submit(&mut s, &[create(0, NodeRef::Id(root), NodeSpec::Box)])[0];
    assert!(format!("{reused:?}").contains("slot: 3, generation: 1"));

    let extra = submit(
        &mut s,
        &[
            create(0, NodeRef::Id(root), NodeSpec::Box),
            create(1, NodeRef::Id(root), NodeSpec::Box),
        ],
    );
    submit(&mut s, &[delete(reused), delete(extra[0]), delete(extra[1])]);
    let before = s.inspect(&all).unwrap();
    let stats = s.stats();
    // 三个空闲槽只消费两个后失败；随后逐个检查全部复用顺序及代数。
    let error = s
        .apply_batch(
            stats.revision,
            &[
                create(0, NodeRef::Id(root), NodeSpec::Box),
                create(1, NodeRef::Id(root), NodeSpec::Box),
                delete(root),
            ],
        )
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Tree);
    assert_eq!(error.op_index, Some(2));
    assert_eq!(s.stats(), stats);
    assert_eq!(s.inspect(&all).unwrap(), before);
    for expected in [
        "slot: 5, generation: 1",
        "slot: 4, generation: 1",
        "slot: 3, generation: 2",
        "slot: 6, generation: 0",
    ] {
        let id = submit(&mut s, &[create(0, NodeRef::Id(root), NodeSpec::Box)])[0];
        assert!(format!("{id:?}").contains(expected));
    }
    for stale in [reused, extra[0], extra[1]] {
        assert_eq!(s.inspect(&[stale]).unwrap_err().code, ErrorCode::Id);
    }
}

#[test]
fn cross_session_stale_reuse_and_no_same_batch_reuse() {
    let mut s = Session::new(Limits::default()).unwrap();
    let other = Session::new(Limits::default()).unwrap();
    assert_eq!(
        s.inspect(&[other.stats().root]).unwrap_err().code,
        ErrorCode::Id
    );
    let root = NodeRef::Id(s.stats().root);
    fail(
        &mut s,
        &[create(0, NodeRef::Id(other.stats().root), NodeSpec::Box)],
        ErrorCode::Id,
    );
    let id = submit(&mut s, &[create(0, root, NodeSpec::Box)])[0];
    let next = submit(&mut s, &[delete(id), create(0, root, NodeSpec::Box)])[0];
    assert!(format!("{next:?}").contains("slot: 2, generation: 0"));
    let reused = submit(&mut s, &[create(0, root, NodeSpec::Box)])[0];
    assert!(format!("{reused:?}").contains("slot: 1, generation: 1"));
    assert_ne!(id, reused);
    assert_eq!(s.inspect(&[id]).unwrap_err().code, ErrorCode::Id);
    fail(&mut s, &[delete(id)], ErrorCode::Id);
}

#[test]
fn utf8_and_lowered_payload_limits() {
    let limits = Limits {
        text_bytes: 4,
        live_text_bytes: 7,
        batch_text_bytes: 16,
        ..Limits::default()
    };
    let mut s = Session::new(limits).unwrap();
    let root = NodeRef::Id(s.stats().root);
    let id = submit(&mut s, &[create(0, root, NodeSpec::Text("\u{1f980}"))])[0];
    assert_eq!(s.stats().live_text_bytes, 4);
    let second = submit(&mut s, &[create(0, root, NodeSpec::Text("中"))])[0];
    assert_eq!(s.stats().live_text_bytes, 7);
    // 单文本与批输入均有余量，只有活文本超一字节。
    fail(&mut s, &[update(second, "abcd")], ErrorCode::Limit);
    submit(&mut s, &[delete(second)]);
    // 活文本与批输入均有余量，只有单文本超一字节。
    fail(&mut s, &[update(id, "\u{1f980}a")], ErrorCode::Limit);
    submit(&mut s, &[update(id, "e\u{301}")]);
    assert_eq!(s.stats().live_text_bytes, 3);

    // 独立批输入上限：每个输入与任一时刻的活文本均远低于其限额。
    let mut batch = Session::new(Limits {
        text_bytes: 8,
        live_text_bytes: 32,
        batch_text_bytes: 5,
        ..Limits::default()
    })
    .unwrap();
    let parent = NodeRef::Id(batch.stats().root);
    let text = submit(&mut batch, &[create(0, parent, NodeSpec::Text(""))])[0];
    submit(&mut batch, &[update(text, "中"), update(text, "ab")]);
    let before = batch.inspect(&[batch.stats().root, text]).unwrap();
    fail(
        &mut batch,
        &[update(text, "中"), update(text, "abc")],
        ErrorCode::Limit,
    );
    assert_eq!(batch.inspect(&[batch.stats().root, text]).unwrap(), before);
    for (last, succeeds) in [("ab", true), ("abc", false)] {
        let ops = [
            create(0, parent, NodeSpec::Text("中")),
            Op::Delete {
                node: NodeRef::Temp(0),
            },
            create(1, parent, NodeSpec::Text(last)),
            Op::Delete {
                node: NodeRef::Temp(1),
            },
        ];
        if succeeds {
            submit(&mut batch, &ops);
        } else {
            fail(&mut batch, &ops, ErrorCode::Limit);
        }
        assert_eq!(batch.inspect(&[batch.stats().root, text]).unwrap(), before);
    }
    let hard = "x".repeat(64 * 1024);
    let mut s = Session::new(Limits::default()).unwrap();
    let root = NodeRef::Id(s.stats().root);
    submit(&mut s, &[create(0, root, NodeSpec::Text(&hard))]);
    fail(
        &mut s,
        &[create(0, root, NodeSpec::Text(&(hard + "x")))],
        ErrorCode::Limit,
    );
}

#[test]
fn slot_op_visit_limits_and_local_update_work() {
    for slots in [0, 4097] {
        assert!(
            Session::new(Limits {
                slots,
                ..Limits::default()
            })
            .is_err()
        );
    }
    let mut s = Session::new(Limits {
        slots: 1,
        ..Limits::default()
    })
    .unwrap();
    let root = NodeRef::Id(s.stats().root);
    fail(&mut s, &[create(0, root, NodeSpec::Box)], ErrorCode::Limit);
    let mut s = Session::new(Limits {
        ops: 0,
        ..Limits::default()
    })
    .unwrap();
    let root = NodeRef::Id(s.stats().root);
    let error = s.apply_batch(0, &[create(0, root, NodeSpec::Box)]);
    assert_eq!(error.unwrap_err().code, ErrorCode::Limit);
    let mut s = Session::new(Limits {
        visits: 3,
        ..Limits::default()
    })
    .unwrap();
    let before = s.stats();
    let error = s.apply_batch(0, &[create(0, NodeRef::Id(before.root), NodeSpec::Box)]);
    assert_eq!(error.unwrap_err().code, ErrorCode::Limit);
    assert_eq!(s.stats(), before);
    let mut s = Session::new(Limits::default()).unwrap();
    let root = NodeRef::Id(s.stats().root);
    let id = submit(&mut s, &[create(0, root, NodeSpec::Text("a"))])[0];
    let cost = s.apply_batch(1, &[update(id, "b")]).unwrap().visits;
    for _ in 0..50 {
        submit(&mut s, &[create(0, root, NodeSpec::Box)]);
    }
    let applied = s.apply_batch(s.stats().revision, &[update(id, "b")]).unwrap();
    assert_eq!(applied.visits, cost);
    let before = s.stats();
    assert_eq!(before.last_batch_visits, applied.visits);
    assert_eq!(s.apply_batch(before.revision, &[]).unwrap().visits, 0);
    assert_eq!(s.stats(), before);
    // 空根创建需要四次访问；上面的三次预算已验证失败边界。
    let mut s = Session::new(Limits {
        visits: 4,
        ..Limits::default()
    })
    .unwrap();
    let root = NodeRef::Id(s.stats().root);
    let applied = s.apply_batch(0, &[create(0, root, NodeSpec::Box)]).unwrap();
    assert_eq!(applied.visits, 4);
}

#[test]
fn snapshots_outlive_update_delete_and_close() {
    use std::rc::Rc;

    let mut s = Session::new(Limits::default()).unwrap();
    let root = NodeRef::Id(s.stats().root);
    let id = submit(&mut s, &[create(0, root, NodeSpec::Text("旧文本"))])[0];
    let old = s.inspect(&[id]).unwrap();
    let Kind::Text(old_text) = &old[0].kind else {
        panic!("应为文本快照");
    };
    let old_weak = Rc::downgrade(old_text);
    assert_eq!(Rc::strong_count(old_text), 2);
    submit(&mut s, &[update(id, "新文本")]);
    assert_eq!(&**old_text, "旧文本");
    assert_eq!(Rc::strong_count(old_text), 1);
    let current = s.inspect(&[id]).unwrap();
    let Kind::Text(current_text) = &current[0].kind else {
        panic!("应为文本快照");
    };
    let current_weak = Rc::downgrade(current_text);
    assert_eq!(Rc::strong_count(current_text), 2);
    submit(&mut s, &[delete(id)]);
    assert_eq!(&**old_text, "旧文本");
    assert_eq!(&**current_text, "新文本");
    assert_eq!(Rc::strong_count(current_text), 1);
    let id = submit(&mut s, &[create(0, root, NodeSpec::Text("关闭前"))])[0];
    let closing = s.inspect(&[id]).unwrap();
    let Kind::Text(closing_text) = &closing[0].kind else {
        panic!("应为文本快照");
    };
    let closing_weak = Rc::downgrade(closing_text);
    assert_eq!(Rc::strong_count(closing_text), 2);
    s.close();
    assert_eq!(&**old_text, "旧文本");
    assert_eq!(&**current_text, "新文本");
    assert_eq!(&**closing_text, "关闭前");
    assert_eq!(Rc::strong_count(closing_text), 1);
    assert_eq!(s.stats().live_text_bytes, 0);
    // 证明 session 已释放强引用；不对分配器保留内存或进程 RSS 作断言。
    drop(old);
    drop(current);
    drop(closing);
    assert!(old_weak.upgrade().is_none());
    assert!(current_weak.upgrade().is_none());
    assert!(closing_weak.upgrade().is_none());
}

#[test]
fn repeated_create_delete_returns_live_payload_to_baseline() {
    let mut s = Session::new(Limits::default()).unwrap();
    let root = NodeRef::Id(s.stats().root);
    for _ in 0..1000 {
        let id = submit(&mut s, &[create(0, root, NodeSpec::Text("中文"))])[0];
        submit(&mut s, &[delete(id)]);
        assert_eq!(s.stats().live_nodes, 1);
        assert_eq!(s.stats().live_text_bytes, 0);
        assert_eq!(s.stats().slots, 2);
        assert_eq!(s.stats().free_slots, 1);
    }
}
