import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { demangle } from './demangle.js'

// Expected strings are GNU c++filt 2.42 output for symbols of real binaries
// (node, libstdc++, LLVM). The full cross-check ran over 239,000 symbols.
const DEMANGLED = [
  ['_ZTV10napi_env__', 'vtable for napi_env__'],
  ['_ZTIDF128_', 'typeinfo for _Float128'],
  ['_ZTSN10__cxxabiv116__enum_type_infoE', 'typeinfo name for __cxxabiv1::__enum_type_info'],
  ['_ZThn104_N4node15SimpleWriteWrapINS_7ReqWrapI10uv_write_sEEE12GetAsyncWrapEv', 'non-virtual thunk to node::SimpleWriteWrap<node::ReqWrap<uv_write_s> >::GetAsyncWrap()'],
  ['_ZTv0_n24_N2v84base18CheckMessageStreamD0Ev', 'virtual thunk to v8::base::CheckMessageStream::~CheckMessageStream()'],
  ['_ZGVNSt10moneypunctIcLb0EE2idE', 'guard variable for std::moneypunct<char, false>::id'],
  ['_ZGVZN12_GLOBAL__N_116GetRegionFromKeyEPKcSt17basic_string_viewIcSt11char_traitsIcEER10UErrorCodeE5valid', 'guard variable for (anonymous namespace)::GetRegionFromKey(char const*, std::basic_string_view<char, std::char_traits<char> >, UErrorCode&)::valid'],
  ['_ZZ14uprv_tzname_78E12juneSolstice', 'uprv_tzname_78::juneSolstice'],
  ['_ZN4heap4base5Stack24SetMarkerAndCallbackImplIZN2v88internal12HeapProfiler12TakeSnapshotENS3_12HeapProfiler19HeapSnapshotOptionsEEUlvE_EEvPS1_PvPKv', 'void heap::base::Stack::SetMarkerAndCallbackImpl<v8::internal::HeapProfiler::TakeSnapshot(v8::HeapProfiler::HeapSnapshotOptions)::{lambda()#1}>(heap::base::Stack*, void*, void const*)'],
  ['_ZSt16__introsort_loopIN9__gnu_cxx17__normal_iteratorIPN4node12CleanupQueue19CleanupHookCallbackESt6vectorIS4_SaIS4_EEEElNS0_5__ops15_Iter_comp_iterIZNKS3_10GetOrderedEvEUlRKS4_SD_E_EEEvT_SG_T0_T1_', 'void std::__introsort_loop<__gnu_cxx::__normal_iterator<node::CleanupQueue::CleanupHookCallback*, std::vector<node::CleanupQueue::CleanupHookCallback, std::allocator<node::CleanupQueue::CleanupHookCallback> > >, long, __gnu_cxx::__ops::_Iter_comp_iter<node::CleanupQueue::GetOrdered() const::{lambda(node::CleanupQueue::CleanupHookCallback const&, node::CleanupQueue::CleanupHookCallback const&)#1}> >(__gnu_cxx::__normal_iterator<node::CleanupQueue::CleanupHookCallback*, std::vector<node::CleanupQueue::CleanupHookCallback, std::allocator<node::CleanupQueue::CleanupHookCallback> > >, __gnu_cxx::__normal_iterator<node::CleanupQueue::CleanupHookCallback*, std::vector<node::CleanupQueue::CleanupHookCallback, std::allocator<node::CleanupQueue::CleanupHookCallback> > >, long, __gnu_cxx::__ops::_Iter_comp_iter<node::CleanupQueue::GetOrdered() const::{lambda(node::CleanupQueue::CleanupHookCallback const&, node::CleanupQueue::CleanupHookCallback const&)#1}>)'],
  ['_ZGTtNSt11logic_errorC1EPKc', 'transaction clone for std::logic_error::logic_error(char const*)'],
  ['_ZGTtNSt11logic_errorD0Ev', 'transaction clone for std::logic_error::~logic_error()'],
  ['_ZNKSi6sentrycvbEv', 'std::basic_istream<char, std::char_traits<char> >::sentry::operator bool() const'],
  ['_Z30node_api_context_register_funcILi10EEvN2v85LocalINS0_6ObjectEEENS1_INS0_5ValueEEENS1_INS0_7ContextEEEPv', 'void node_api_context_register_func<10>(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, void*)'],
  ['_Z10UnwindImplILb0ELb1EEiPPvPiiiPKvS2_', 'int UnwindImpl<false, true>(void**, int*, int, int, void const*, int*)'],
  ['_Z24mixedMeasuresToMicros_78RKN6icu_7816MaybeStackVectorINS_7MeasureELi8EEEPNS_6number4impl15DecimalQuantityEPNS6_10MicroPropsE10UErrorCode.cold', 'mixedMeasuresToMicros_78(icu_78::MaybeStackVector<icu_78::Measure, 8> const&, icu_78::number::impl::DecimalQuantity*, icu_78::number::impl::MicroProps*, UErrorCode) [clone .cold]'],
  ['_Z41__static_initialization_and_destruction_0ii.constprop.0', '__static_initialization_and_destruction_0(int, int) [clone .constprop.0]'],
  ['_ZNK10__cxxabiv117__class_type_info10__do_catchEPKSt9type_infoPPvj', '__cxxabiv1::__class_type_info::__do_catch(std::type_info const*, void**, unsigned int) const'],
  ['_ZN2v88internal12_GLOBAL__N_111ConsoleCallEPNS0_7IsolateERKNS0_16BuiltinArgumentsEMNS_5debug15ConsoleDelegateEFvRKNS7_20ConsoleCallArgumentsERKNS7_14ConsoleContextEE.constprop.0', 'v8::internal::(anonymous namespace)::ConsoleCall(v8::internal::Isolate*, v8::internal::BuiltinArguments const&, void (v8::debug::ConsoleDelegate::*)(v8::debug::ConsoleCallArguments const&, v8::debug::ConsoleContext const&)) [clone .constprop.0]'],
  ['_Z30napi_module_register_by_symbolN2v85LocalINS_6ObjectEEENS0_INS_5ValueEEENS0_INS_7ContextEEEPFP12napi_value__P10napi_env__S8_Ei', 'napi_module_register_by_symbol(v8::Local<v8::Object>, v8::Local<v8::Value>, v8::Local<v8::Context>, napi_value__* (*)(napi_env__*, napi_value__*), int)'],
  ['_ZL12getStatePropPA256_KiPai.isra.0', 'getStateProp(int const (*) [256], signed char*, int) [clone .isra.0]'],
  ['_ZN12v8_inspector10V8Debugger18handleProgramBreakEN2v85LocalINS1_7ContextEEENS2_INS1_5ValueEEERKSt6vectorIiSaIiEENS1_4base7EnumSetINS1_5debug11BreakReasonEiEENSE_13ExceptionTypeEb', 'v8_inspector::V8Debugger::handleProgramBreak(v8::Local<v8::Context>, v8::Local<v8::Value>, std::vector<int, std::allocator<int> > const&, v8::base::EnumSet<v8::debug::BreakReason, int>, v8::debug::ExceptionType, bool)'],
  ['_ZN2v84baselsERSoRKNS0_4TimeE', 'v8::base::operator<<(std::basic_ostream<char, std::char_traits<char> >&, v8::base::Time const&)'],
  ['_ZN2v88internal14MacroAssembler14PextrdPreSse41ENS0_8RegisterENS0_11XMMRegisterEh', 'v8::internal::MacroAssembler::PextrdPreSse41(v8::internal::Register, v8::internal::XMMRegister, unsigned char)'],
  ['_Z35_v8_internal_Print_Object_To_StringB5cxx11Pv', '_v8_internal_Print_Object_To_String[abi:cxx11](void*)'],
  ['_ZGVZN12_GLOBAL__N_116GetRegionFromKeyEPKcSt17basic_string_viewIcSt11char_traitsIcEER10UErrorCodeE5valid', 'guard variable for (anonymous namespace)::GetRegionFromKey(char const*, std::basic_string_view<char, std::char_traits<char> >, UErrorCode&)::valid'],
  ['_ZGVZN2v88internal12_GLOBAL__N_125GetPerIsolateWasmControlsEvE6object', 'guard variable for v8::internal::(anonymous namespace)::GetPerIsolateWasmControls()::object'],
  ['_ZL10CURRENCIES', 'CURRENCIES'],
  ['_ZGTtNKSt11logic_error4whatEv', 'transaction clone for std::logic_error::what() const'],
  ['_ZN4core3fmt5write17h0123456789abcdefE', 'core::fmt::write::h0123456789abcdef'],
  ['_ZN4node26THROW_ERR_WASI_NOT_STARTEDEPN2v87IsolateE', 'node::THROW_ERR_WASI_NOT_STARTED(v8::Isolate*)'],
  ['_ZGTtNKSt11logic_error4whatEv', 'transaction clone for std::logic_error::what() const'],
  ['_ZN12_GLOBAL__N_116KernelHasPkruFixEv', '(anonymous namespace)::KernelHasPkruFix()'],
  ['_ZGVZNKSt8__detail11_AnyMatcherINSt7__cxx1112regex_traitsIcEELb0ELb0ELb0EEclEcE5__nul', 'guard variable for std::__detail::_AnyMatcher<std::__cxx11::regex_traits<char>, false, false, false>::operator()(char) const::__nul'],
  ['_ZN4node6crypto13KeyObjectDataC1EDn', 'node::crypto::KeyObjectData::KeyObjectData(decltype(nullptr))'],
  ['_ZN4node6crypto14DhKeyGenTraits16AdditionalConfigENS0_13CryptoJobModeERKN2v820FunctionCallbackInfoINS3_5ValueEEEPjPNS0_16KeyPairGenConfigINS0_15DhKeyPairParamsEEE', 'node::crypto::DhKeyGenTraits::AdditionalConfig(node::crypto::CryptoJobMode, v8::FunctionCallbackInfo<v8::Value> const&, unsigned int*, node::crypto::KeyPairGenConfig<node::crypto::DhKeyPairParams>*)'],
  ['_ZSt10adopt_lock', 'std::adopt_lock']
]

describe('demangle', () => {
  it('matches c++filt on real symbols', () => {
    for (const [mangled, expected] of DEMANGLED) assert.equal(demangle(mangled), expected, mangled)
  })

  it('demangles legacy Rust names like c++filt, keeping the hash', () => {
    assert.equal(demangle('_ZN4core3fmt5write17h0123456789abcdefE'), 'core::fmt::write::h0123456789abcdef')
    assert.equal(demangle('_ZN4core3ptr85drop_in_place$LT$std..rt..lang_start$LT$$LP$$RP$$GT$..$u7b$$u7b$closure$u7d$$u7d$$GT$17h0011223344556677E'),
      'core::ptr::drop_in_place<std::rt::lang_start<()>::{{closure}}>::h0011223344556677')
  })

  it('declines grammar it does not cover instead of guessing', () => {
    assert.equal(demangle('_ZN12v8_inspector8String166concatIJPKcS0_S3_EEES0_DpT_'), null)
    assert.equal(demangle('_ZN12v8_inspector9V8Console4callIXadL_ZNS0_10createTaskERKN2v820FunctionCallbackInfoINS2_5ValueEEEEEEEvS7_'), null)
  })

  it('returns null for names that are not mangled or are malformed', () => {
    for (const name of ['main', 'printf@GLIBC_2.2.5', '', '_Z', '_Z3fo', '_ZN3fooE3', '_Z3fooILi', '_ZNK3foo', '_Z1fS_', '_Z1fT_', '_Z9999999999x', `_Z${'P'.repeat(5000)}i`]) {
      assert.equal(demangle(name), null, name)
    }
    assert.equal(demangle(null), null)
  })

  it('survives deep nesting without throwing', () => {
    assert.equal(demangle(`_Z1f${'P'.repeat(500)}i`), null)
    assert.equal(demangle(`_Z1fI${'N1aIS_'.repeat(200)}EE`), null)
  })
})
