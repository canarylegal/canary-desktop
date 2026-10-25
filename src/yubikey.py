#!/usr/bin/env python3
"""Perform a WebAuthn ceremony with a USB security key via libfido2.

Electron on Linux does not show a PIN or touch prompt, so navigator.credentials
fails with NotAllowedError. This helper talks to the key itself.
"""

import ctypes
import hashlib
import json
import sys

FIDO_OK = 0x00
FIDO_ERR_TIMEOUT = 0x05
FIDO_ERR_CREDENTIAL_EXCLUDED = 0x19
FIDO_ERR_NO_CREDENTIALS = 0x2E
FIDO_ERR_USER_ACTION_TIMEOUT = 0x2F
FIDO_ERR_NOT_ALLOWED = 0x30
FIDO_ERR_PIN_INVALID = 0x31
FIDO_ERR_PIN_BLOCKED = 0x32
FIDO_ERR_PIN_AUTH_INVALID = 0x33
FIDO_ERR_PIN_AUTH_BLOCKED = 0x34
FIDO_ERR_PIN_REQUIRED = 0x36
FIDO_ERR_ACTION_TIMEOUT = 0x3A
FIDO_OPT_FALSE = 1
FIDO_OPT_TRUE = 2
COSE_ES256 = -7
COSE_EDDSA = -8
COSE_ES384 = -35


def cbor_head(major, length):
    prefix = major << 5
    if length < 24:
        return bytes([prefix | length])
    if length < 256:
        return bytes([prefix | 24, length])
    if length < 65536:
        return bytes([prefix | 25]) + length.to_bytes(2, 'big')
    if length < 2**32:
        return bytes([prefix | 26]) + length.to_bytes(4, 'big')
    return bytes([prefix | 27]) + length.to_bytes(8, 'big')


def cbor_int(value):
    if value >= 0:
        return cbor_head(0, value)
    return cbor_head(1, -1 - value)


def cbor_bytes(value):
    return cbor_head(2, len(value)) + value


def cbor_text(value):
    raw = value.encode('utf-8')
    return cbor_head(3, len(raw)) + raw


def cbor_array(items):
    return cbor_head(4, len(items)) + b''.join(items)


def cbor_map(pairs):
    return cbor_head(5, len(pairs)) + b''.join(key + value for key, value in pairs)


def b64url_encode(raw):
    import base64

    return base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def b64url_decode(text):
    import base64

    pad = '=' * ((4 - len(text) % 4) % 4)
    return base64.urlsafe_b64decode(text + pad)


def client_data_json(kind, challenge, origin):
    type_name = 'webauthn.create' if kind == 'create' else 'webauthn.get'
    raw = json.dumps(
        {
            'type': type_name,
            'challenge': challenge,
            'origin': origin,
            'crossOrigin': False,
        },
        separators=(',', ':'),
    ).encode('utf-8')
    return raw, hashlib.sha256(raw).digest()


def attestation_object(fmt, auth_data, attstmt):
    # attstmt is the authenticator's own CBOR map. auth_data is the raw
    # authenticator data, not libfido2's CBOR-wrapped copy.
    if not attstmt:
        attstmt = cbor_map([])
    return cbor_map(
        [
            (cbor_text('fmt'), cbor_text(fmt or 'packed')),
            (cbor_text('authData'), cbor_bytes(auth_data)),
            (cbor_text('attStmt'), attstmt),
        ]
    )


class Fido:
    def __init__(self):
        self.lib = ctypes.CDLL('libfido2.so.1')
        lib = self.lib
        lib.fido_init.argtypes = [ctypes.c_int]
        lib.fido_init(0)
        self._bufs = []
        lib.fido_strerr.argtypes = [ctypes.c_int]
        lib.fido_strerr.restype = ctypes.c_char_p

        for name in (
            'fido_dev_new',
            'fido_dev_info_new',
            'fido_dev_info_ptr',
            'fido_cred_new',
            'fido_assert_new',
            'fido_cbor_info_new',
        ):
            getattr(lib, name).restype = ctypes.c_void_p
        lib.fido_dev_info_path.argtypes = [ctypes.c_void_p]
        lib.fido_dev_info_path.restype = ctypes.c_char_p
        lib.fido_dev_info_ptr.argtypes = [ctypes.c_void_p, ctypes.c_size_t]
        lib.fido_dev_info_free.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_size_t]
        lib.fido_dev_info_manifest.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
        lib.fido_dev_open.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.fido_dev_close.argtypes = [ctypes.c_void_p]
        lib.fido_dev_free.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        lib.fido_dev_set_timeout.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_dev_make_cred.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p]
        lib.fido_dev_get_assert.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_char_p]
        lib.fido_dev_get_cbor_info.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        if hasattr(lib, 'fido_dev_get_retry_count'):
            lib.fido_dev_get_retry_count.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int)]

        lib.fido_cred_set_type.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_cred_set_clientdata_hash.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        lib.fido_cred_set_rp.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_char_p]
        lib.fido_cred_set_user.argtypes = [
            ctypes.c_void_p,
            ctypes.c_void_p,
            ctypes.c_size_t,
            ctypes.c_char_p,
            ctypes.c_char_p,
            ctypes.c_char_p,
        ]
        lib.fido_cred_set_rk.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_cred_set_uv.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_cred_exclude.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        lib.fido_cred_free.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        lib.fido_cred_fmt.argtypes = [ctypes.c_void_p]
        lib.fido_cred_fmt.restype = ctypes.c_char_p
        lib.fido_cred_type.argtypes = [ctypes.c_void_p]
        for name in (
            'fido_cred_authdata_ptr',
            'fido_cred_authdata_raw_ptr',
            'fido_cred_attstmt_ptr',
            'fido_cred_sig_ptr',
            'fido_cred_id_ptr',
            'fido_cred_x5c_ptr',
        ):
            if hasattr(lib, name):
                getattr(lib, name).argtypes = [ctypes.c_void_p]
                getattr(lib, name).restype = ctypes.c_void_p
        for name in (
            'fido_cred_authdata_len',
            'fido_cred_authdata_raw_len',
            'fido_cred_attstmt_len',
            'fido_cred_sig_len',
            'fido_cred_id_len',
            'fido_cred_x5c_len',
        ):
            if hasattr(lib, name):
                getattr(lib, name).argtypes = [ctypes.c_void_p]
                getattr(lib, name).restype = ctypes.c_size_t

        lib.fido_assert_set_clientdata_hash.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        lib.fido_assert_set_rp.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        lib.fido_assert_allow_cred.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t]
        lib.fido_assert_set_up.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_assert_set_uv.argtypes = [ctypes.c_void_p, ctypes.c_int]
        lib.fido_assert_free.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        lib.fido_assert_count.argtypes = [ctypes.c_void_p]
        lib.fido_assert_count.restype = ctypes.c_size_t
        for name in (
            'fido_assert_authdata_ptr',
            'fido_assert_authdata_raw_ptr',
            'fido_assert_sig_ptr',
            'fido_assert_id_ptr',
            'fido_assert_user_id_ptr',
        ):
            getattr(lib, name).argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            getattr(lib, name).restype = ctypes.c_void_p
        for name in (
            'fido_assert_authdata_len',
            'fido_assert_authdata_raw_len',
            'fido_assert_sig_len',
            'fido_assert_id_len',
            'fido_assert_user_id_len',
        ):
            getattr(lib, name).argtypes = [ctypes.c_void_p, ctypes.c_size_t]
            getattr(lib, name).restype = ctypes.c_size_t

        lib.fido_cbor_info_free.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
        lib.fido_cbor_info_options_len.argtypes = [ctypes.c_void_p]
        lib.fido_cbor_info_options_len.restype = ctypes.c_size_t
        lib.fido_cbor_info_options_name_ptr.argtypes = [ctypes.c_void_p]
        lib.fido_cbor_info_options_name_ptr.restype = ctypes.POINTER(ctypes.c_char_p)
        lib.fido_cbor_info_options_value_ptr.argtypes = [ctypes.c_void_p]
        lib.fido_cbor_info_options_value_ptr.restype = ctypes.POINTER(ctypes.c_uint8)

    def error(self, code):
        text = self.lib.fido_strerr(code)
        return text.decode() if text else f'FIDO error {code}'

    def free(self, fn, handle):
        if not handle:
            return
        holder = ctypes.c_void_p(handle)
        fn(ctypes.byref(holder))

    def blob(self, ptr, length):
        if not ptr or not length:
            return b''
        return ctypes.string_at(ptr, length)

    def keep(self, data):
        buf = ctypes.create_string_buffer(data)
        self._bufs.append(buf)
        return ctypes.cast(buf, ctypes.c_void_p)

    def devices(self):
        lib = self.lib
        count = 16
        devlist = lib.fido_dev_info_new(count)
        found = ctypes.c_size_t()
        rc = lib.fido_dev_info_manifest(devlist, count, ctypes.byref(found))
        paths = []
        if rc == FIDO_OK:
            for index in range(found.value):
                item = lib.fido_dev_info_ptr(devlist, index)
                path = lib.fido_dev_info_path(item)
                if path:
                    paths.append(path.decode())
        holder = ctypes.c_void_p(devlist)
        lib.fido_dev_info_free(ctypes.byref(holder), count)
        return paths

    def open_first(self):
        lib = self.lib
        paths = self.devices()
        if not paths:
            return None, None
        for path in paths:
            dev = lib.fido_dev_new()
            rc = lib.fido_dev_open(dev, path.encode())
            if rc == FIDO_OK:
                lib.fido_dev_set_timeout(dev, 90000)
                return dev, path
            self.free(lib.fido_dev_free, dev)
        return None, paths[0]

    def close(self, dev):
        if not dev:
            return
        self.lib.fido_dev_close(dev)
        self.free(self.lib.fido_dev_free, dev)

    def options(self, dev):
        lib = self.lib
        info = lib.fido_cbor_info_new()
        rc = lib.fido_dev_get_cbor_info(dev, info)
        found = {}
        if rc == FIDO_OK:
            names = lib.fido_cbor_info_options_name_ptr(info)
            values = lib.fido_cbor_info_options_value_ptr(info)
            for index in range(lib.fido_cbor_info_options_len(info)):
                name = names[index]
                if name:
                    found[name.decode()] = bool(values[index])
        self.free(lib.fido_cbor_info_free, info)
        return found

    def retries(self, dev):
        if not hasattr(self.lib, 'fido_dev_get_retry_count'):
            return None
        count = ctypes.c_int()
        rc = self.lib.fido_dev_get_retry_count(dev, ctypes.byref(count))
        if rc != FIDO_OK:
            return None
        return count.value

    def fail(self, code, dev=None):
        retries = self.retries(dev) if dev else None
        if code in (FIDO_ERR_PIN_REQUIRED,):
            status = 'pin-required'
        elif code in (FIDO_ERR_PIN_INVALID, FIDO_ERR_PIN_AUTH_INVALID):
            status = 'pin-invalid'
        elif code in (FIDO_ERR_PIN_BLOCKED, FIDO_ERR_PIN_AUTH_BLOCKED):
            status = 'pin-blocked'
        elif code == FIDO_ERR_CREDENTIAL_EXCLUDED:
            status = 'excluded'
        elif code == FIDO_ERR_NO_CREDENTIALS:
            status = 'no-credentials'
        elif code in (FIDO_ERR_TIMEOUT, FIDO_ERR_USER_ACTION_TIMEOUT, FIDO_ERR_ACTION_TIMEOUT):
            status = 'timeout'
        elif code == FIDO_ERR_NOT_ALLOWED:
            status = 'not-allowed'
        else:
            status = 'error'
        return {
            'ok': False,
            'code': status,
            'message': self.error(code),
            'retries': retries,
        }

    def info(self):
        dev, path = self.open_first()
        if not dev:
            return {'ok': False, 'code': 'no-device', 'message': 'No security key was found.'}
        try:
            options = self.options(dev)
            return {
                'ok': True,
                'path': path,
                'clientPin': bool(options.get('clientPin')),
                'alwaysUv': bool(options.get('alwaysUv')),
            }
        finally:
            self.close(dev)

    def create(self, request):
        lib = self.lib
        dev, _path = self.open_first()
        if not dev:
            return {'ok': False, 'code': 'no-device', 'message': 'No security key was found.'}
        cred = lib.fido_cred_new()
        try:
            client_json, client_hash = client_data_json('create', request['challenge'], request['origin'])
            user_id = b64url_decode(request['userId'])
            alg = int(request.get('alg') or COSE_ES256)
            check(lib.fido_cred_set_type(cred, alg))
            check(lib.fido_cred_set_clientdata_hash(cred, self.keep(client_hash), len(client_hash)))
            check(lib.fido_cred_set_rp(cred, request['rpId'].encode(), (request.get('rpName') or request['rpId']).encode()))
            check(
                lib.fido_cred_set_user(
                    cred,
                    self.keep(user_id),
                    len(user_id),
                    (request.get('userName') or 'user').encode(),
                    (request.get('userDisplayName') or request.get('userName') or 'user').encode(),
                    None,
                )
            )
            check(lib.fido_cred_set_rk(cred, FIDO_OPT_TRUE if request.get('resident') else FIDO_OPT_FALSE))
            check(lib.fido_cred_set_uv(cred, FIDO_OPT_TRUE if request.get('uv') else FIDO_OPT_FALSE))
            for excluded in request.get('excludeCredentials') or []:
                raw = b64url_decode(excluded)
                rc = lib.fido_cred_exclude(cred, self.keep(raw), len(raw))
                if rc != FIDO_OK:
                    return self.fail(rc, dev)
            pin = request.get('pin')
            rc = lib.fido_dev_make_cred(dev, cred, pin.encode() if pin else None)
            if rc != FIDO_OK:
                return self.fail(rc, dev)
            auth_data = self.blob(lib.fido_cred_authdata_raw_ptr(cred), lib.fido_cred_authdata_raw_len(cred))
            attstmt = self.blob(lib.fido_cred_attstmt_ptr(cred), lib.fido_cred_attstmt_len(cred))
            cred_id = self.blob(lib.fido_cred_id_ptr(cred), lib.fido_cred_id_len(cred))
            if not auth_data or not cred_id:
                return {'ok': False, 'code': 'error', 'message': 'The security key returned an incomplete credential.'}
            fmt = lib.fido_cred_fmt(cred)
            fmt = fmt.decode() if fmt else 'packed'
            alg_out = int(lib.fido_cred_type(cred) or alg)
            attestation = attestation_object(fmt, auth_data, attstmt)
            return {
                'ok': True,
                'credential': {
                    'id': b64url_encode(cred_id),
                    'rawId': b64url_encode(cred_id),
                    'publicKeyAlgorithm': alg_out,
                    'response': {
                        'clientDataJSON': b64url_encode(client_json),
                        'attestationObject': b64url_encode(attestation),
                        'authenticatorData': b64url_encode(auth_data),
                    },
                },
            }
        finally:
            self.free(lib.fido_cred_free, cred)
            self.close(dev)

    def get(self, request):
        lib = self.lib
        dev, _path = self.open_first()
        if not dev:
            return {'ok': False, 'code': 'no-device', 'message': 'No security key was found.'}
        assertion = lib.fido_assert_new()
        try:
            client_json, client_hash = client_data_json('get', request['challenge'], request['origin'])
            check(lib.fido_assert_set_clientdata_hash(assertion, self.keep(client_hash), len(client_hash)))
            check(lib.fido_assert_set_rp(assertion, request['rpId'].encode()))
            check(lib.fido_assert_set_up(assertion, FIDO_OPT_TRUE))
            check(lib.fido_assert_set_uv(assertion, FIDO_OPT_TRUE if request.get('uv') else FIDO_OPT_FALSE))
            for allowed in request.get('allowCredentials') or []:
                raw = b64url_decode(allowed)
                rc = lib.fido_assert_allow_cred(assertion, self.keep(raw), len(raw))
                if rc != FIDO_OK:
                    return self.fail(rc, dev)
            pin = request.get('pin')
            rc = lib.fido_dev_get_assert(dev, assertion, pin.encode() if pin else None)
            if rc != FIDO_OK:
                return self.fail(rc, dev)
            if lib.fido_assert_count(assertion) < 1:
                return {'ok': False, 'code': 'no-credentials', 'message': 'The security key did not return a credential.'}
            auth_data = self.blob(
                lib.fido_assert_authdata_raw_ptr(assertion, 0),
                lib.fido_assert_authdata_raw_len(assertion, 0),
            )
            signature = self.blob(lib.fido_assert_sig_ptr(assertion, 0), lib.fido_assert_sig_len(assertion, 0))
            cred_id = self.blob(lib.fido_assert_id_ptr(assertion, 0), lib.fido_assert_id_len(assertion, 0))
            user_id = self.blob(lib.fido_assert_user_id_ptr(assertion, 0), lib.fido_assert_user_id_len(assertion, 0))
            if not auth_data or not signature or not cred_id:
                return {'ok': False, 'code': 'error', 'message': 'The security key returned an incomplete assertion.'}
            return {
                'ok': True,
                'credential': {
                    'id': b64url_encode(cred_id),
                    'rawId': b64url_encode(cred_id),
                    'response': {
                        'clientDataJSON': b64url_encode(client_json),
                        'authenticatorData': b64url_encode(auth_data),
                        'signature': b64url_encode(signature),
                        'userHandle': b64url_encode(user_id) if user_id else None,
                    },
                },
            }
        finally:
            self.free(lib.fido_assert_free, assertion)
            self.close(dev)


def check(rc):
    if rc != FIDO_OK:
        raise FidoError(rc)


class FidoError(Exception):
    def __init__(self, code):
        super().__init__(f'FIDO error {code}')
        self.code = code


def main():
    try:
        request = json.loads(sys.stdin.read() or '{}')
        fido = Fido()
        action = request.get('action')
        if action == 'info':
            result = fido.info()
        elif action == 'create':
            result = fido.create(request)
        elif action == 'get':
            result = fido.get(request)
        elif action == 'self-test':
            raw, digest = client_data_json('get', 'abc', 'https://example.test')
            assert len(digest) == 32
            raw_auth = b'\x01\x02\x03'
            stmt = cbor_map([(cbor_text('alg'), cbor_int(COSE_ES256)), (cbor_text('sig'), cbor_bytes(b'\x04'))])
            blob = attestation_object('packed', raw_auth, stmt)
            assert bytes([0x43]) + raw_auth in blob
            assert blob[0] >> 5 == 5
            result = {'ok': True, 'clientData': raw.decode()}
        else:
            result = {'ok': False, 'code': 'error', 'message': 'Unknown security-key action.'}
    except FidoError as exc:
        result = Fido().fail(exc.code)
    except Exception as exc:
        result = {'ok': False, 'code': 'error', 'message': str(exc)}
    sys.stdout.write(json.dumps(result))
    sys.stdout.write('\n')


if __name__ == '__main__':
    main()
