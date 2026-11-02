// Compile the pure decoder as an integration-test module: the cdylib test
// harness is disabled, and these tests must not link or initialize a JS VM.
#[path = "../src/wire.rs"]
#[allow(dead_code)]
mod wire;

use ink_rust_core::{Kind, Limits, NodeId, NodeRef, NodeSpec, Op, Session};
use serde_json::{Value, json};

fn names(ids: &[NodeId], aliases: &[(&str, NodeId)]) -> Value {
    json!(
        ids.iter()
            .map(|id| {
                aliases
                    .iter()
                    .find(|(_, candidate)| candidate == id)
                    .unwrap()
                    .0
            })
            .collect::<Vec<_>>()
    )
}

#[test]
fn shared_normal_scene() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../fixtures/session-v1.json")).unwrap();
    assert_eq!(fixture["version"], 1);
    let mut s = Session::new(Limits::default()).unwrap();
    let root = s.stats().root;
    let created = s
        .apply_batch(
            0,
            &[
                Op::Create {
                    temp: 8,
                    parent: NodeRef::Id(root),
                    kind: NodeSpec::Box,
                },
                Op::Create {
                    temp: 2,
                    parent: NodeRef::Id(root),
                    kind: NodeSpec::Text(fixture["initialText"].as_str().unwrap()),
                },
            ],
        )
        .unwrap()
        .created;
    let (text, container) = (created[0].1, created[1].1);
    let aliases = [("root", root), ("box", container), ("text", text)];
    assert_eq!(
        names(&s.inspect(&[root]).unwrap()[0].children, &aliases),
        fixture["afterCreate"]
    );
    s.apply_batch(
        1,
        &[
            Op::UpdateText {
                node: NodeRef::Id(text),
                text: fixture["updatedText"].as_str().unwrap(),
            },
            Op::Reparent {
                node: NodeRef::Id(text),
                parent: NodeRef::Id(container),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        names(&s.inspect(&[root]).unwrap()[0].children, &aliases),
        fixture["afterReparent"]
    );
    assert_eq!(
        names(&s.inspect(&[container]).unwrap()[0].children, &aliases),
        fixture["boxChildren"]
    );
    let snapshot = s.inspect(&[text]).unwrap();
    let Kind::Text(actual) = &snapshot[0].kind else {
        panic!("expected text")
    };
    assert_eq!(actual.as_ref(), fixture["updatedText"].as_str().unwrap());
    s.apply_batch(
        2,
        &[
            Op::Delete {
                node: NodeRef::Id(text),
            },
            Op::Delete {
                node: NodeRef::Id(container),
            },
        ],
    )
    .unwrap();
    assert_eq!(
        names(&s.inspect(&[root]).unwrap()[0].children, &aliases),
        fixture["afterDelete"]
    );
}
