use ink_rust_core as core;
use napi::bindgen_prelude::{JsObjectValue, ToNapiValue, TypedArrayType};
use napi::{Env, JsValue, Result, Status, Unknown};
use napi_derive::napi;
use std::cell::RefCell;
mod wire;

#[napi(object)]
pub struct NodeId {
    pub session: String,
    pub slot: u32,
    pub generation: u32,
}
impl From<core::NodeId> for NodeId {
    fn from(id: core::NodeId) -> Self {
        let (session, slot, generation) = id.parts();
        Self {
            session: session.to_string(),
            slot: slot as u32,
            generation,
        }
    }
}
#[napi(object)]
pub struct Stats {
    pub root: NodeId,
    pub revision: u32,
    pub closed: bool,
    pub slots: u32,
    pub free_slots: u32,
    pub retired_slots: u32,
    pub live_nodes: u32,
    pub live_text_bytes: u32,
    pub last_batch_visits: u32,
}
#[napi(object)]
pub struct Created {
    pub temp: u32,
    pub id: NodeId,
}
#[napi(object)]
pub struct Applied {
    pub revision: u32,
    pub created: Vec<Created>,
    pub visits: u32,
}
#[napi(object)]
pub struct Snapshot {
    pub id: NodeId,
    pub parent: Option<NodeId>,
    pub children: Vec<NodeId>,
    pub kind: String,
    pub text: Option<String>,
}
struct Decoder<'a> {
    env: &'a Env,
    index: Option<u32>,
}
impl Decoder<'_> {
    fn error(&self, code: &str) -> napi::Error {
        let result = (|| {
            let mut error = self
                .env
                .create_error(napi::Error::new(Status::InvalidArg, code))?;
            error.set_named_property("code", code)?;
            if let Some(index) = self.index {
                error.set_named_property("opIndex", index)?;
            }
            Ok::<_, napi::Error>(napi::Error::from(error.into_unknown(self.env)?))
        })();
        result.unwrap_or_else(|error| error)
    }
    fn wire_error(&self, error: wire::Error) -> napi::Error {
        Decoder {
            env: self.env,
            index: error.index,
        }
        .error(error.code)
    }
    fn core_error(&self, error: core::Error) -> napi::Error {
        let code = match error.code {
            core::ErrorCode::Closed => "Closed",
            core::ErrorCode::Revision => "Revision",
            core::ErrorCode::Id => "Id",
            core::ErrorCode::Ref => "Ref",
            core::ErrorCode::Tree => "Tree",
            core::ErrorCode::Limit => "Limit",
            core::ErrorCode::Exhausted => "Exhausted",
        };
        Decoder {
            env: self.env,
            index: error.op_index.map(|i| i as u32).or(self.index),
        }
        .error(code)
    }
    // Only native brand/metadata APIs: never read JS properties, including .buffer.
    #[allow(deprecated)]
    fn packet(&self, value: Unknown<'_>, max: usize) -> Result<Vec<u8>> {
        if !value.is_typedarray()? {
            return Err(self.error("Input"));
        }
        let array = napi::JsTypedArray::try_from(value)?
            .into_value()
            .map_err(|error| {
                if error.status == Status::PendingException {
                    error
                } else {
                    self.error("Input")
                }
            })?;
        if array.typedarray_type != TypedArrayType::Uint8
            || !array.arraybuffer.is_arraybuffer()?
            || array.arraybuffer.is_detached()?
        {
            return Err(self.error("Input"));
        }
        if array.length > max {
            return Err(self.error("Limit"));
        }
        // SAB excluded before borrowing. No N-API/JS during this one owned copy;
        // same-thread resizable buffers cannot resize/detach during the borrow.
        let bytes: &[u8] = array.as_ref();
        Ok(bytes.to_vec())
    }
}
#[napi]
pub fn protocol_version() -> u32 {
    1
}
#[napi]
pub struct Session {
    inner: RefCell<core::Session>,
}
#[napi]
impl Session {
    #[napi(constructor)]
    pub fn new(env: Env) -> Result<Self> {
        let d = Decoder {
            env: &env,
            index: None,
        };
        Ok(Self {
            inner: RefCell::new(
                core::Session::new(core::Limits::default()).map_err(|e| d.core_error(e))?,
            ),
        })
    }
    #[napi]
    pub fn stats(&self, env: Env) -> Result<Stats> {
        let d = Decoder {
            env: &env,
            index: None,
        };
        let session = self
            .inner
            .try_borrow_mut()
            .map_err(|_| d.error("Reentrant"))?;
        let s = session.stats();
        Ok(Stats {
            root: s.root.into(),
            revision: s.revision,
            closed: s.closed,
            slots: s.slots as u32,
            free_slots: s.free_slots as u32,
            retired_slots: s.retired_slots as u32,
            live_nodes: s.live_nodes as u32,
            live_text_bytes: s.live_text_bytes as u32,
            last_batch_visits: s.last_batch_visits as u32,
        })
    }
    #[napi]
    pub fn close(&self, env: Env) -> Result<()> {
        let d = Decoder {
            env: &env,
            index: None,
        };
        self.inner
            .try_borrow_mut()
            .map_err(|_| d.error("Reentrant"))?
            .close();
        Ok(())
    }
    // Priority: guard, closed, brand/backing, packet size, complete wire decode,
    // revision, checked IDs, core transaction. Only per-op failures carry opIndex.
    #[napi]
    pub fn apply_batch(&self, env: Env, packet: Unknown<'_>) -> Result<Applied> {
        let d = Decoder {
            env: &env,
            index: None,
        };
        let mut session = self
            .inner
            .try_borrow_mut()
            .map_err(|_| d.error("Reentrant"))?;
        if session.stats().closed {
            return Err(d.error("Closed"));
        }
        let bytes = d.packet(packet, wire::MAX_BATCH)?;
        let (revision, staged) = wire::batch(&bytes).map_err(|e| d.wire_error(e))?;
        if revision != session.stats().revision {
            return Err(d.error("Revision"));
        }
        let ops = staged
            .iter()
            .enumerate()
            .map(|(index, op)| {
                op.resolve(&session).map_err(|e| {
                    Decoder {
                        env: &env,
                        index: Some(index as u32),
                    }
                    .core_error(e)
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let applied = session
            .apply_batch(revision, &ops)
            .map_err(|e| d.core_error(e))?;
        Ok(Applied {
            revision: applied.revision,
            created: applied
                .created
                .into_iter()
                .map(|(temp, id)| Created {
                    temp,
                    id: id.into(),
                })
                .collect(),
            visits: applied.visits as u32,
        })
    }
    #[napi]
    pub fn inspect(&self, env: Env, packet: Unknown<'_>) -> Result<Vec<Snapshot>> {
        let d = Decoder {
            env: &env,
            index: None,
        };
        let session = self
            .inner
            .try_borrow_mut()
            .map_err(|_| d.error("Reentrant"))?;
        if session.stats().closed {
            return Err(d.error("Closed"));
        }
        let bytes = d.packet(packet, wire::MAX_INSPECT)?;
        let ids = wire::inspect(&bytes).map_err(|e| d.wire_error(e))?;
        let ids = ids
            .iter()
            .map(|id| id.resolve(&session).map_err(|e| d.core_error(e)))
            .collect::<Result<Vec<_>>>()?;
        let snapshots = session.inspect(&ids).map_err(|e| d.core_error(e))?;
        Ok(snapshots
            .into_iter()
            .map(|s| {
                let (kind, text) = match s.kind {
                    core::Kind::Box => ("box", None),
                    core::Kind::Text(text) => ("text", Some(text.to_string())),
                };
                Snapshot {
                    id: s.id.into(),
                    parent: s.parent.map(Into::into),
                    children: s.children.into_iter().map(Into::into).collect(),
                    kind: kind.into(),
                    text,
                }
            })
            .collect())
    }
}
